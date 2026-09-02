import type { ClientEvent, MatrixClient } from 'matrix-js-sdk';
import { getMatrixConfig } from './config';
import { requestMatrixSession, type MatrixSession } from './session';

type Runtime = {
  client: MatrixClient;
  sessionKey: string;
};

let runtime: Runtime | null = null;
let initializing: Promise<MatrixClient> | null = null;
let releaseCryptoLease: (() => void) | null = null;
let cryptoLeaseTask: Promise<void> | null = null;

function databaseSuffix(session: MatrixSession): string {
  return `${session.userId}--${session.deviceId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function waitUntilPrepared(
  client: MatrixClient,
  syncEvent: ClientEvent.Sync,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      client.removeListener(syncEvent, onSync);
      reject(new Error('MATRIX_INITIAL_SYNC_TIMEOUT'));
    }, timeoutMs);

    const onSync = (state: string): void => {
      if (state !== 'PREPARED') return;
      window.clearTimeout(timer);
      client.removeListener(syncEvent, onSync);
      resolve();
    };

    client.on(syncEvent, onSync);
  });
}

async function createRuntime(session: MatrixSession): Promise<MatrixClient> {
  const config = getMatrixConfig();
  // Keep the 7.5 MiB Rust/WASM crypto engine out of the initial application
  // path. It is downloaded only when Matrix is explicitly enabled.
  const sdk = await import('matrix-js-sdk');
  const store = new sdk.IndexedDBStore({
    indexedDB: window.indexedDB,
    dbName: `forsure-matrix-sync-${databaseSuffix(session)}`,
  });
  await store.startup();

  const client = sdk.createClient({
    baseUrl: config.homeserverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    deviceId: session.deviceId,
    localTimeoutMs: 15_000,
    scheduler: new sdk.MatrixScheduler(),
    store,
    timelineSupport: true,
    useAuthorizationHeader: true,
  });

  // Rust/WASM crypto owns device sessions, room keys and the persistent crypto DB.
  try {
    await client.initRustCrypto();
    client.on(sdk.RoomEvent.MyMembership, (room, membership) => {
      if (membership !== sdk.KnownMembership.Invite) return;
      void client.joinRoom(room.roomId).catch((error) => {
        console.error('[matrix] failed to join an invited room', error);
      });
    });
    const prepared = waitUntilPrepared(client, sdk.ClientEvent.Sync);
    client.startClient({ initialSyncLimit: 30 });
    await prepared;
  } catch (error) {
    client.stopClient();
    throw error;
  }

  runtime = {
    client,
    sessionKey: `${session.userId}\u0000${session.deviceId}`,
  };
  return client;
}

async function createRuntimeWithBrowserLease(session: MatrixSession): Promise<MatrixClient> {
  if (!navigator.locks) return createRuntime(session);

  const lockName = `forsure-matrix-crypto-${databaseSuffix(session)}`;
  return new Promise<MatrixClient>((resolve, reject) => {
    cryptoLeaseTask = navigator.locks.request(
      lockName,
      { ifAvailable: true, mode: 'exclusive' },
      async (lock) => {
        if (!lock) {
          reject(new Error('MATRIX_CRYPTO_ACTIVE_IN_ANOTHER_TAB'));
          return;
        }

        try {
          const client = await createRuntime(session);
          resolve(client);
          await new Promise<void>((release) => {
            releaseCryptoLease = release;
          });
        } catch (error) {
          reject(error);
        } finally {
          releaseCryptoLease = null;
        }
      },
    ).catch(reject);
  });
}

/**
 * Returns the sole Matrix client for this browser context. Concurrent callers
 * share the exact same initialization promise to protect the Rust crypto store.
 */
export async function getMatrixClient(): Promise<MatrixClient> {
  const config = getMatrixConfig();
  if (!config.enabled) throw new Error('MATRIX_DISABLED');
  if (runtime) return runtime.client;
  if (initializing) return initializing;

  initializing = requestMatrixSession()
    .then(async (session) => {
      const nextSessionKey = `${session.userId}\u0000${session.deviceId}`;
      if (runtime?.sessionKey === nextSessionKey) return runtime.client;
      if (runtime) await stopMatrixClient();
      return createRuntimeWithBrowserLease(session);
    })
    .finally(() => {
      initializing = null;
    });

  return initializing;
}

export async function stopMatrixClient(): Promise<void> {
  const active = runtime;
  runtime = null;
  if (!active) return;
  active.client.stopClient();
  await active.client.store.save(true);
  releaseCryptoLease?.();
  await cryptoLeaseTask?.catch(() => undefined);
  cryptoLeaseTask = null;
}
