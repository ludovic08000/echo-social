import {
  reqToPromise,
  runTxOn,
} from '@/lib/crypto/indexedDbTx';
import { runCrossTabExclusive } from '@/lib/crypto/crossTabLock';

const OUTBOX_STORE = 'outbound';
const OUTBOX_KEY_STORE = 'device-keys';
const OUTBOX_KEY_PREFIX = 'outbox-vault-key::';
const OUTBOX_AAD_PREFIX = 'FORSURE-OUTBOX-v1|';
const OUTBOX_SENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const OUTBOX_CHANNEL_NAME = 'forsure:aegis-outbox:v1';

export type OutboxStatus =
  | 'draft'
  | 'pending_local'
  | 'encrypting'
  | 'waiting_secure_channel'
  | 'sending'
  | 'sent'
  | 'retry_pending'
  | 'failed_visible';

export interface OutboxExtra {
  view_once?: boolean;
  document_url?: string | null;
  document_name?: string | null;
  document_mime?: string | null;
  document_size_bytes?: number | null;
}

export interface OutboxPreparedCopy {
  message_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  sender_user_id: string;
  sender_device_id: string;
  encrypted_body: string;
}

export interface OutboxPayload {
  localId: string;
  traceId: string;
  conversationId: string;
  senderId: string;
  /** Human-readable text used by the optimistic bubble. */
  plaintext: string;
  /** Exact plaintext transported inside per-device envelopes (long-message pointer when applicable). */
  transportPlaintext?: string | null;
  /** Stable encrypted-only parent body sent to the server. */
  encryptedBody: string | null;
  /** Exact Aegis content-key capsule, protected by this encrypted local outbox. */
  keyCapsule?: string | null;
  /** Exact per-device envelopes, persisted before the RPC for crash-safe idempotent replay. */
  preparedCopies?: OutboxPreparedCopy[];
  /** Monotonic server route version used to prepare `preparedCopies`. */
  routeVersion?: string | null;
  /** Backup policy captured when the durable send was first created. */
  archiveBackupEnabled?: boolean;
  /** Optional account-wrapped archive prepared before transport. */
  archiveBody?: string | null;
  imageUrl: string | null;
  extra?: OutboxExtra;
  status: OutboxStatus;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  reservedServerId: string | null;
}

export interface OutboxChangeEvent {
  action: 'put' | 'delete';
  localId: string;
  userId: string;
  conversationId: string;
  updatedAt: number;
}

interface OutboxKeyRecord {
  id: string;
  key: CryptoKey;
  createdAt: number;
}

interface StoredOutboxRecord {
  localId: string;
  userId: string;
  conversationId: string;
  status: OutboxStatus;
  createdAt: number;
  updatedAt: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  version: 1;
}

const keyPromises = new Map<string, Promise<CryptoKey>>();
let outboxChannel: BroadcastChannel | null | undefined;

function aadFor(userId: string, conversationId: string, localId: string): Uint8Array {
  return new TextEncoder().encode(
    `${OUTBOX_AAD_PREFIX}${userId}|${conversationId}|${localId}`,
  );
}

function rowLockName(localId: string): string {
  return `aegis:outbox-row:${localId}`;
}

function getOutboxChannel(): BroadcastChannel | null {
  if (outboxChannel !== undefined) return outboxChannel;
  if (typeof window === 'undefined' || typeof window.BroadcastChannel === 'undefined') {
    outboxChannel = null;
    return null;
  }
  try {
    outboxChannel = new window.BroadcastChannel(OUTBOX_CHANNEL_NAME);
  } catch {
    outboxChannel = null;
  }
  return outboxChannel;
}

function notifyOutboxChange(change: OutboxChangeEvent): void {
  try {
    getOutboxChannel()?.postMessage(change);
  } catch {
    // Cross-tab UI refresh is best-effort. IndexedDB remains authoritative.
  }
}

export function subscribeOutboxChanges(
  listener: (change: OutboxChangeEvent) => void,
): () => void {
  const channel = getOutboxChannel();
  if (!channel) return () => undefined;
  const onMessage = (event: MessageEvent<OutboxChangeEvent>) => {
    const change = event.data;
    if (
      !change ||
      (change.action !== 'put' && change.action !== 'delete') ||
      typeof change.localId !== 'string' ||
      typeof change.userId !== 'string' ||
      typeof change.conversationId !== 'string'
    ) {
      return;
    }
    listener(change);
  };
  channel.addEventListener('message', onMessage);
  return () => channel.removeEventListener('message', onMessage);
}

function localGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return runTxOn('msg-queue', [storeName], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(storeName).get(key) as IDBRequest<T | undefined>),
  );
}

function localPut<T>(storeName: string, value: T): Promise<void> {
  return runTxOn('msg-queue', [storeName], 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(storeName).put(value as object)).then(() => undefined),
  );
}

function localDelete(storeName: string, key: IDBValidKey): Promise<void> {
  return runTxOn('msg-queue', [storeName], 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(storeName).delete(key)).then(() => undefined),
  );
}

function localGetAll<T>(storeName: string): Promise<T[]> {
  return runTxOn('msg-queue', [storeName], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(storeName).getAll() as IDBRequest<T[]>),
  );
}

/**
 * The final read and insert happen in one IndexedDB readwrite transaction.
 * Two tabs may generate candidates concurrently, but only the first committed
 * key is stored and every contender returns that same non-extractable key.
 */
async function createOrLoadOutboxKey(userId: string): Promise<CryptoKey> {
  const id = `${OUTBOX_KEY_PREFIX}${userId}`;
  const existing = await localGet<OutboxKeyRecord>(OUTBOX_KEY_STORE, id);
  if (existing?.key) return existing.key;

  const candidate = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return runTxOn('msg-queue', [OUTBOX_KEY_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(OUTBOX_KEY_STORE);
    const raced = await reqToPromise(
      store.get(id) as IDBRequest<OutboxKeyRecord | undefined>,
    );
    if (raced?.key) return raced.key;

    const record = { id, key: candidate, createdAt: Date.now() } satisfies OutboxKeyRecord;
    await reqToPromise(store.add(record));
    return candidate;
  });
}

async function getOrCreateOutboxKey(userId: string): Promise<CryptoKey> {
  let promise = keyPromises.get(userId);
  if (!promise) {
    promise = createOrLoadOutboxKey(userId).catch((error) => {
      keyPromises.delete(userId);
      throw error;
    });
    keyPromises.set(userId, promise);
  }
  return promise;
}

async function encryptPayload(userId: string, payload: OutboxPayload): Promise<StoredOutboxRecord> {
  const key = await getOrCreateOutboxKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aadFor(userId, payload.conversationId, payload.localId) as BufferSource,
      tagLength: 128,
    },
    key,
    plaintext,
  );

  return {
    localId: payload.localId,
    userId,
    conversationId: payload.conversationId,
    status: payload.status,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
    ciphertext,
    version: 1,
  };
}

async function decryptRecord(userId: string, record: StoredOutboxRecord): Promise<OutboxPayload | null> {
  if (record.userId !== userId || record.version !== 1) return null;
  try {
    const key = await getOrCreateOutboxKey(userId);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(record.iv) as BufferSource,
        additionalData: aadFor(userId, record.conversationId, record.localId) as BufferSource,
        tagLength: 128,
      },
      key,
      record.ciphertext,
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as OutboxPayload;
    if (
      payload.localId !== record.localId ||
      payload.conversationId !== record.conversationId ||
      payload.senderId !== userId
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function putOutboxPayload(userId: string, payload: OutboxPayload): Promise<void> {
  if (!userId || !payload.localId || payload.senderId !== userId) return;
  const normalized: OutboxPayload = {
    ...payload,
    updatedAt: Date.now(),
  };

  await runCrossTabExclusive(
    rowLockName(payload.localId),
    async () => {
      await localPut(OUTBOX_STORE, await encryptPayload(userId, normalized));
    },
    { waitTimeoutMs: 15_000, leaseMs: 45_000 },
  );
  notifyOutboxChange({
    action: 'put',
    localId: normalized.localId,
    userId,
    conversationId: normalized.conversationId,
    updatedAt: normalized.updatedAt,
  });
}

export async function patchOutboxPayload(
  userId: string,
  localId: string,
  patch: Partial<OutboxPayload>,
): Promise<OutboxPayload | null> {
  return runCrossTabExclusive(
    rowLockName(localId),
    async () => {
      const record = await localGet<StoredOutboxRecord>(OUTBOX_STORE, localId);
      if (!record) return null;
      const current = await decryptRecord(userId, record);
      if (!current) return null;
      const next: OutboxPayload = {
        ...current,
        ...patch,
        localId: current.localId,
        conversationId: current.conversationId,
        senderId: current.senderId,
        updatedAt: Date.now(),
      };
      await localPut(OUTBOX_STORE, await encryptPayload(userId, next));
      notifyOutboxChange({
        action: 'put',
        localId,
        userId,
        conversationId: next.conversationId,
        updatedAt: next.updatedAt,
      });
      return next;
    },
    { waitTimeoutMs: 15_000, leaseMs: 45_000 },
  );
}

export async function getOutboxPayload(
  userId: string,
  localId: string,
): Promise<OutboxPayload | null> {
  const record = await localGet<StoredOutboxRecord>(OUTBOX_STORE, localId);
  if (!record) return null;
  // Never delete an unreadable durable row automatically. A later key recovery
  // or browser repair may make it readable again; explicit cleanup owns loss.
  return decryptRecord(userId, record);
}

export async function listOutboxPayloads(
  userId: string,
  conversationId?: string,
): Promise<OutboxPayload[]> {
  let records: StoredOutboxRecord[];
  if (conversationId) {
    records = await runTxOn('msg-queue', [OUTBOX_STORE], 'readonly', (tx) => {
      const store = tx.objectStore(OUTBOX_STORE);
      if (store.indexNames.contains('by-user-conversation')) {
        return reqToPromise(
          store.index('by-user-conversation').getAll([userId, conversationId]) as IDBRequest<StoredOutboxRecord[]>,
        );
      }
      return reqToPromise(store.getAll() as IDBRequest<StoredOutboxRecord[]>);
    });
  } else {
    records = await localGetAll<StoredOutboxRecord>(OUTBOX_STORE);
  }

  const candidates = records.filter((record) =>
    record.userId === userId && (!conversationId || record.conversationId === conversationId),
  );
  const decrypted = await Promise.all(candidates.map((record) => decryptRecord(userId, record)));

  return decrypted
    .filter((payload): payload is OutboxPayload => payload !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
}

export async function deleteOutboxPayload(localId: string): Promise<void> {
  await runCrossTabExclusive(
    rowLockName(localId),
    async () => {
      const record = await localGet<StoredOutboxRecord>(OUTBOX_STORE, localId);
      if (!record) return;
      await localDelete(OUTBOX_STORE, localId);
      notifyOutboxChange({
        action: 'delete',
        localId,
        userId: record.userId,
        conversationId: record.conversationId,
        updatedAt: Date.now(),
      });
    },
    { waitTimeoutMs: 15_000, leaseMs: 45_000 },
  );
}

/**
 * Pending encrypted jobs are never age- or count-pruned. Only rows already
 * marked `sent` may be garbage-collected, and normal authoritative delivery
 * deletes those immediately.
 */
export async function pruneOutbox(userId: string): Promise<void> {
  const now = Date.now();
  const records = (await localGetAll<StoredOutboxRecord>(OUTBOX_STORE))
    .filter((record) => record.userId === userId);
  const acknowledged = records.filter((record) =>
    record.status === 'sent' && now - record.updatedAt > OUTBOX_SENT_RETENTION_MS,
  );
  await Promise.all(acknowledged.map((record) => deleteOutboxPayload(record.localId)));
}

export const __test__ = {
  aadFor,
  createOrLoadOutboxKey,
  clearKeyCache(): void {
    keyPromises.clear();
  },
};
