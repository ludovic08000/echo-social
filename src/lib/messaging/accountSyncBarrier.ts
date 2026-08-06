export type AccountSyncPhase = 'idle' | 'syncing' | 'ready' | 'failed';

type AccountSyncState = {
  phase: AccountSyncPhase;
  generation: number;
  active?: Promise<void>;
  errorCode?: string;
};

const states = new Map<string, AccountSyncState>();

function normalizeErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'UNKNOWN');
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9:_-]+/g, '_')
    .slice(0, 120);
  return normalized || 'UNKNOWN';
}

function dispatchSyncState(
  userId: string,
  phase: AccountSyncPhase,
  errorCode?: string,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('forsure:account-sync-state', {
    detail: { userId, phase, errorCode },
  }));
}

/**
 * Runs one authoritative account refresh per user. Concurrent callers share the
 * same promise so device approval, inbox recovery and UI refetches cannot race.
 */
export function beginAccountSynchronization(
  userId: string,
  operation: () => Promise<void>,
): Promise<void> {
  if (!userId) return Promise.reject(new Error('ACCOUNT_SYNC_USER_REQUIRED'));

  const current = states.get(userId);
  if (current?.phase === 'syncing' && current.active) return current.active;

  const generation = (current?.generation ?? 0) + 1;
  dispatchSyncState(userId, 'syncing');

  const active = Promise.resolve()
    .then(operation)
    .then(() => {
      const latest = states.get(userId);
      if (latest?.generation !== generation) return;
      states.set(userId, { phase: 'ready', generation });
      dispatchSyncState(userId, 'ready');
    })
    .catch((error: unknown) => {
      const errorCode = normalizeErrorCode(error);
      const latest = states.get(userId);
      if (latest?.generation === generation) {
        states.set(userId, { phase: 'failed', generation, errorCode });
        dispatchSyncState(userId, 'failed', errorCode);
      }
      throw error;
    });

  states.set(userId, { phase: 'syncing', generation, active });
  return active;
}

/** Message creation must wait until an approval-triggered account sync ends. */
export async function waitForAccountSynchronization(userId: string): Promise<void> {
  if (!userId) throw new Error('ACCOUNT_SYNC_USER_REQUIRED');
  const current = states.get(userId);
  if (!current || current.phase === 'idle' || current.phase === 'ready') return;
  if (current.active) await current.active;

  const latest = states.get(userId);
  if (latest?.phase === 'failed') {
    throw new Error(`ACCOUNT_SYNC_FAILED:${latest.errorCode ?? 'UNKNOWN'}`);
  }
}

export function getAccountSynchronizationPhase(userId: string): AccountSyncPhase {
  return states.get(userId)?.phase ?? 'idle';
}

export function resetAccountSynchronization(userId?: string): void {
  if (userId) {
    states.delete(userId);
    return;
  }
  states.clear();
}
