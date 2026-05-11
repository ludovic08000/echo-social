import { getLocalSecurityEpoch } from './securityEpoch';
import { runTxOn } from './indexedDbTx';

const RATCHET_STORE = 'ratchet-states';
const INVALIDATED_EPOCH_KEY = 'forsure-e2ee-invalidated-epoch:';

function invalidationKey(userId: string) {
  return `${INVALIDATED_EPOCH_KEY}${userId}`;
}

async function withRatchetTx(
  op: (store: IDBObjectStore) => void,
  reason: string,
): Promise<void> {
  try {
    await runTxOn('ratchet', [RATCHET_STORE], 'readwrite', (tx) => {
      op(tx.objectStore(RATCHET_STORE));
    });
  } catch (err) {
    console.warn('[E2EE][SESSION] ratchet tx failed', { reason, err });
  }
}

export async function clearAllRatchetSessions(reason: string): Promise<void> {
  await withRatchetTx((store) => { store.clear(); }, `clear-all:${reason}`);
  console.warn('[E2EE][SESSION] all ratchet sessions invalidated', { reason });
}

export async function clearConversationRatchetSession(conversationId: string, reason: string): Promise<void> {
  await withRatchetTx((store) => { store.delete(conversationId); }, `clear-one:${reason}`);
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
