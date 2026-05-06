import { getLocalSecurityEpoch } from './securityEpoch';

const RATCHET_DB = 'forsure-ratchet';
const RATCHET_STORE = 'ratchet-states';
const INVALIDATED_EPOCH_KEY = 'forsure-e2ee-invalidated-epoch:';

function invalidationKey(userId: string) {
  return `${INVALIDATED_EPOCH_KEY}${userId}`;
}

function openRatchetDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RATCHET_DB);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

export async function clearAllRatchetSessions(reason: string): Promise<void> {
  try {
    const db = await openRatchetDB();
    if (!db.objectStoreNames.contains(RATCHET_STORE)) {
      db.close();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RATCHET_STORE, 'readwrite');
      tx.objectStore(RATCHET_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    db.close();
    console.warn('[E2EE][SESSION] all ratchet sessions invalidated', { reason });
  } catch (error) {
    console.warn('[E2EE][SESSION] ratchet invalidation failed', error);
  }
}

export async function clearConversationRatchetSession(conversationId: string, reason: string): Promise<void> {
  try {
    const db = await openRatchetDB();
    if (!db.objectStoreNames.contains(RATCHET_STORE)) {
      db.close();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RATCHET_STORE, 'readwrite');
      tx.objectStore(RATCHET_STORE).delete(conversationId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    db.close();
    console.warn('[E2EE][SESSION] conversation ratchet invalidated', { conversationId, reason });
  } catch (error) {
    console.warn('[E2EE][SESSION] conversation ratchet invalidation failed', error);
  }
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
