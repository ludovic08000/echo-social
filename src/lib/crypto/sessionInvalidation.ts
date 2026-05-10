import { getLocalSecurityEpoch } from './securityEpoch';

const RATCHET_DB = 'forsure-ratchet';
const RATCHET_STORE = 'ratchet-states';
const INVALIDATED_EPOCH_KEY = 'forsure-e2ee-invalidated-epoch:';

function invalidationKey(userId: string) {
  return `${INVALIDATED_EPOCH_KEY}${userId}`;
}

/**
 * The ratchet DB is independent from the main E2EE DB but we apply the same
 * Safari-safe pattern: open lazily, never hold the connection, retry on
 * the transient errors raised when the page is suspended/backgrounded.
 */
const TRANSIENT_BACKOFF_MS = [50, 200, 600];

function isTransient(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'InvalidStateError' || err.name === 'TransactionInactiveError';
  }
  const msg = String((err as { message?: string } | undefined)?.message ?? err ?? '');
  return msg.includes('database connection is closing') || msg.includes('transaction has finished');
}

function openRatchetDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RATCHET_DB);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function withRatchetTx<T>(
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  reason: string,
): Promise<T | undefined> {
  for (let attempt = 0; attempt <= TRANSIENT_BACKOFF_MS.length; attempt++) {
    try {
      const db = await openRatchetDB();
      if (!db.objectStoreNames.contains(RATCHET_STORE)) {
        try { db.close(); } catch {}
        return undefined;
      }
      const tx = db.transaction(RATCHET_STORE, 'readwrite');
      const store = tx.objectStore(RATCHET_STORE);
      const req = fn(store);
      const value = await new Promise<T>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
      });
      try { db.close(); } catch {}
      return value;
    } catch (err) {
      if (!isTransient(err) || attempt === TRANSIENT_BACKOFF_MS.length) {
        console.warn('[E2EE][SESSION] ratchet tx failed', { reason, err });
        return undefined;
      }
      await new Promise((r) => setTimeout(r, TRANSIENT_BACKOFF_MS[attempt]));
    }
  }
  return undefined;
}

export async function clearAllRatchetSessions(reason: string): Promise<void> {
  await withRatchetTx((store) => store.clear(), `clear-all:${reason}`);
  console.warn('[E2EE][SESSION] all ratchet sessions invalidated', { reason });
}

export async function clearConversationRatchetSession(conversationId: string, reason: string): Promise<void> {
  await withRatchetTx((store) => store.delete(conversationId), `clear-one:${reason}`);
  console.warn('[E2EE][SESSION] conversation ratchet invalidated', { conversationId, reason });
}

export function markEpochInvalidated(userId: string, epoch = getLocalSecurityEpoch(userId)): void {
  localStorage.setItem(invalidationKey(userId), String(epoch));
}

export function getInvalidatedEpoch(userId: string): number {
  const raw = localStorage.getItem(invalidationKey(userId));
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

export function isSessionEpochInvalid(userId: string, sessionEpoch?: number | null): boolean {
  if (!sessionEpoch) return false;
  const invalidatedEpoch = getInvalidatedEpoch(userId);
  return sessionEpoch <= invalidatedEpoch;
}

export function startSessionInvalidationWatcher(): void {
  window.addEventListener('forsure-e2ee-security-epoch-changed', (event) => {
    const detail = (event as CustomEvent<{ userId?: string; epoch?: number; reason?: string }>).detail;
    if (!detail?.userId) return;

    markEpochInvalidated(detail.userId, detail.epoch || getLocalSecurityEpoch(detail.userId));
    void clearAllRatchetSessions(detail.reason || 'security_epoch_changed');
  });

  window.addEventListener('forsure-e2ee-security-code-changed', (event) => {
    const detail = (event as CustomEvent<{ userId?: string; reason?: string }>).detail;
    if (!detail?.userId) return;

    markEpochInvalidated(detail.userId);
    void clearAllRatchetSessions(detail.reason || 'security_code_changed');
  });
}
