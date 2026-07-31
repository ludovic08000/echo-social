import { reqToPromise, runTxOn } from './indexedDbTx';

const LEASE_STORE = 'leases';
const DEFAULT_WAIT_TIMEOUT_MS = 45_000;
const DEFAULT_LEASE_MS = 90_000;
const MIN_POLL_MS = 40;
const MAX_POLL_MS = 120;

interface LeaseRecord {
  name: string;
  ownerId: string;
  token: string;
  expiresAt: number;
  updatedAt: number;
}

export interface CrossTabLockOptions {
  waitTimeoutMs?: number;
  leaseMs?: number;
}

export class CrossTabLockTimeoutError extends Error {
  readonly code = 'E2EE_CROSS_TAB_LOCK_TIMEOUT';

  constructor(readonly lockName: string) {
    super(`Cross-tab lock timeout: ${lockName}`);
    this.name = 'CrossTabLockTimeoutError';
  }
}

const localChains = new Map<string, Promise<void>>();

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

const ownerId = randomId();

function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pollDelay(): number {
  return MIN_POLL_MS + Math.floor(Math.random() * (MAX_POLL_MS - MIN_POLL_MS + 1));
}

async function runWithLocalQueue<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = localChains.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  localChains.set(name, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (localChains.get(name) === tail) localChains.delete(name);
  }
}

async function tryAcquireLease(
  name: string,
  leaseOwnerId: string,
  leaseMs: number,
): Promise<LeaseRecord | null> {
  const proposedToken = randomId();
  return runTxOn('msg-queue', [LEASE_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const current = await reqToPromise(
      store.get(name) as IDBRequest<LeaseRecord | undefined>,
    );
    const now = Date.now();
    if (current && current.expiresAt > now) return null;

    const lease: LeaseRecord = {
      name,
      ownerId: leaseOwnerId,
      token: proposedToken,
      expiresAt: now + leaseMs,
      updatedAt: now,
    };
    await reqToPromise(store.put(lease));
    return lease;
  });
}

async function renewLease(lease: LeaseRecord, leaseMs: number): Promise<boolean> {
  return runTxOn('msg-queue', [LEASE_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const current = await reqToPromise(
      store.get(lease.name) as IDBRequest<LeaseRecord | undefined>,
    );
    if (
      !current ||
      current.ownerId !== lease.ownerId ||
      current.token !== lease.token
    ) {
      return false;
    }

    const now = Date.now();
    const renewed: LeaseRecord = {
      ...current,
      expiresAt: now + leaseMs,
      updatedAt: now,
    };
    await reqToPromise(store.put(renewed));
    return true;
  });
}

async function ownsLease(lease: LeaseRecord): Promise<boolean> {
  return runTxOn('msg-queue', [LEASE_STORE], 'readonly', async (tx) => {
    const current = await reqToPromise(
      tx.objectStore(LEASE_STORE).get(lease.name) as IDBRequest<LeaseRecord | undefined>,
    );
    return Boolean(
      current &&
      current.ownerId === lease.ownerId &&
      current.token === lease.token &&
      current.expiresAt > Date.now(),
    );
  });
}

async function releaseLease(lease: LeaseRecord): Promise<void> {
  await runTxOn('msg-queue', [LEASE_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const current = await reqToPromise(
      store.get(lease.name) as IDBRequest<LeaseRecord | undefined>,
    );
    if (
      current &&
      current.ownerId === lease.ownerId &&
      current.token === lease.token
    ) {
      await reqToPromise(store.delete(lease.name));
    }
  });
}

async function acquireLease(
  name: string,
  leaseOwnerId: string,
  waitTimeoutMs: number,
  leaseMs: number,
): Promise<LeaseRecord> {
  const deadline = Date.now() + waitTimeoutMs;
  for (;;) {
    const lease = await tryAcquireLease(name, leaseOwnerId, leaseMs);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CrossTabLockTimeoutError(name);
    await sleep(Math.min(pollDelay(), remaining));
  }
}

async function runWithIndexedDbLease<T>(
  name: string,
  leaseOwnerId: string,
  task: () => Promise<T>,
  options: CrossTabLockOptions,
): Promise<T> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const leaseMs = Math.max(10_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  const lease = await acquireLease(name, leaseOwnerId, waitTimeoutMs, leaseMs);
  let lost = false;
  let renewing = false;
  const heartbeatMs = Math.max(2_000, Math.floor(leaseMs / 3));
  const heartbeat = setInterval(() => {
    if (renewing || lost) return;
    renewing = true;
    void renewLease(lease, leaseMs)
      .then((renewed) => {
        if (!renewed) lost = true;
      })
      .catch(() => {
        lost = true;
      })
      .finally(() => {
        renewing = false;
      });
  }, heartbeatMs);

  try {
    const result = await task();
    if (lost || !(await ownsLease(lease))) {
      // The critical section may already have completed an irreversible,
      // idempotent server transaction. Converting that success into a local
      // failure would recreate a pending bubble after its durable row was
      // correctly deleted. Report the lease anomaly without falsifying the
      // completed task result. Core Aegis operations remain bounded well below
      // the lease duration and re-check durable state on every later attempt.
      console.warn('[E2EE][LOCK] lease ownership changed after task completion', { name });
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    await releaseLease(lease).catch(() => undefined);
  }
}

async function runWithWebLock<T>(
  name: string,
  task: () => Promise<T>,
  waitTimeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let acquired = false;
  const timer = setTimeout(() => {
    if (!acquired) controller.abort();
  }, waitTimeoutMs);

  try {
    return await navigator.locks.request(
      name,
      { mode: 'exclusive', signal: controller.signal },
      async () => {
        acquired = true;
        clearTimeout(timer);
        return task();
      },
    );
  } catch (error) {
    if (controller.signal.aborted && !acquired) {
      throw new CrossTabLockTimeoutError(name);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Executes one critical section exclusively across browser tabs.
 *
 * Web Locks is authoritative when available. Older browsers use a renewable
 * IndexedDB lease stored in the same device-local database as the encrypted
 * outbox. The in-memory queue prevents same-tab reordering before either
 * cross-tab primitive is entered.
 */
export function runCrossTabExclusive<T>(
  name: string,
  task: () => Promise<T>,
  options: CrossTabLockOptions = {},
): Promise<T> {
  return runWithLocalQueue(name, () => {
    const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    if (hasWebLocks()) return runWithWebLock(name, task, waitTimeoutMs);
    return runWithIndexedDbLease(name, ownerId, task, options);
  });
}

export const __test__ = {
  ownerId,
  runWithOwner<T>(
    testOwnerId: string,
    name: string,
    task: () => Promise<T>,
    options: CrossTabLockOptions = {},
  ): Promise<T> {
    return runWithIndexedDbLease(name, testOwnerId, task, options);
  },
  async clearLeases(): Promise<void> {
    await runTxOn('msg-queue', [LEASE_STORE], 'readwrite', (tx) =>
      reqToPromise(tx.objectStore(LEASE_STORE).clear()),
    );
    localChains.clear();
  },
};
