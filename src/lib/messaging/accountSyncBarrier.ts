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

/** Attente bornée: une panne de sync ne doit jamais bloquer l'envoi ad vitam. */
export const ACCOUNT_SYNC_WAIT_TIMEOUT_MS = 8_000;

/**
 * Message creation waits for an approval-triggered account sync, but only for a
 * bounded window. `ensureAegisDeviceReady` reste l'autorité cryptographique en
 * aval: la barrière n'est qu'un ordonnancement, pas un contrôle de sécurité.
 */
export async function waitForAccountSynchronization(userId: string): Promise<void> {
  if (!userId) throw new Error('ACCOUNT_SYNC_USER_REQUIRED');
  const current = states.get(userId);
  if (!current || current.phase === 'idle' || current.phase === 'ready') return;

  // Un échec passé est signalé à l'initiateur du sync, jamais latché ici.
  if (current.phase === 'failed') return;
  if (!current.active) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    current.active.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ACCOUNT_SYNC_WAIT_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function getAccountSynchronizationPhase(userId: string): AccountSyncPhase {
  return states.get(userId)?.phase ?? 'idle';
}

export function getAccountSynchronizationError(userId: string): string | null {
  const current = states.get(userId);
  return current?.phase === 'failed' ? (current.errorCode ?? 'UNKNOWN') : null;
}


export function resetAccountSynchronization(userId?: string): void {
  if (userId) {
    states.delete(userId);
    return;
  }
  states.clear();
}
