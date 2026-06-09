/**
 * CryptoStateMachine — single source of truth for the local E2EE identity
 * lifecycle. Prevents the "IndexedDB empty → recreate identity in a loop"
 * footgun by guarding the `identity_creating` transition behind explicit
 * server-backup checks and a per-session lock.
 *
 * States
 * ------
 *   uninitialized
 *     └─ storage_checking
 *           ├─ identity_loaded ──┐
 *           ├─ backup_restore_required ─ backup_restoring ─┤
 *           └─ identity_creating ─────────────────────────┴─ ready
 *
 *   Terminal: storage_unavailable, compromised
 *
 * Allowed transitions are enforced. Illegal transitions throw.
 *
 * UI/hooks must NOT decide on their own to recreate an identity. They listen
 * to `forsure:crypto-state` events and call `requestEnsure(userId)`.
 */

export type CryptoState =
  | 'uninitialized'
  | 'storage_checking'
  | 'identity_loaded'
  | 'backup_restore_required'
  | 'backup_restoring'
  | 'identity_creating'
  | 'ready'
  | 'storage_unavailable'
  | 'compromised';

const ALLOWED: Record<CryptoState, CryptoState[]> = {
  uninitialized: ['storage_checking', 'storage_unavailable'],
  storage_checking: [
    'identity_loaded',
    'backup_restore_required',
    'identity_creating',
    'storage_unavailable',
    'compromised',
  ],
  backup_restore_required: ['backup_restoring', 'identity_creating', 'storage_unavailable'],
  backup_restoring: ['identity_loaded', 'backup_restore_required', 'compromised'],
  identity_creating: ['identity_loaded', 'compromised'],
  identity_loaded: ['ready', 'compromised'],
  ready: ['ready', 'storage_checking', 'compromised'],
  storage_unavailable: ['storage_checking'],
  compromised: [],
};

export interface MachineSnapshot {
  state: CryptoState;
  reason: string;
  changedAt: number;
  identityCreatedThisSession: boolean;
}

interface UserMachine {
  snapshot: MachineSnapshot;
  ensurePromise: Promise<void> | null;
}

const machines = new Map<string, UserMachine>();

function emit(userId: string, snap: MachineSnapshot) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('forsure:crypto-state', {
      detail: { userId, ...snap },
    }),
  );
}

function get(userId: string): UserMachine {
  let m = machines.get(userId);
  if (!m) {
    m = {
      snapshot: {
        state: 'uninitialized',
        reason: 'init',
        changedAt: Date.now(),
        identityCreatedThisSession: false,
      },
      ensurePromise: null,
    };
    machines.set(userId, m);
  }
  return m;
}

export function getSnapshot(userId: string): MachineSnapshot {
  return { ...get(userId).snapshot };
}

export function transition(userId: string, to: CryptoState, reason: string): MachineSnapshot {
  const m = get(userId);
  const from = m.snapshot.state;

  if (from === to) {
    m.snapshot = {
      ...m.snapshot,
      reason,
      changedAt: Date.now(),
    };
    emit(userId, m.snapshot);
    return { ...m.snapshot };
  }

  if (!ALLOWED[from].includes(to)) {
    const err = new Error(`[CryptoStateMachine] illegal transition ${from} → ${to} (${reason})`);
    console.error(err.message);
    throw err;
  }

  // HARD LOCK: identity_creating may only happen once per session.
  if (to === 'identity_creating') {
    if (m.snapshot.identityCreatedThisSession) {
      const err = new Error(
        `[CryptoStateMachine] identity_creating refused: already created this session (${reason})`,
      );
      console.error(err.message);
      throw err;
    }
    m.snapshot.identityCreatedThisSession = true;
  }

  m.snapshot = {
    ...m.snapshot,
    state: to,
    reason,
    changedAt: Date.now(),
  };
  console.log('[E2EE][state]', { userId: userId.slice(0, 8), from, to, reason });
  emit(userId, m.snapshot);
  return { ...m.snapshot };
}

/**
 * Guard the boot orchestrator. Multiple concurrent callers share the same
 * promise so we never start two boot flows in parallel.
 */
export function withEnsureLock(userId: string, fn: () => Promise<void>): Promise<void> {
  const m = get(userId);
  if (m.ensurePromise) return m.ensurePromise;
  m.ensurePromise = (async () => {
    try {
      await fn();
    } finally {
      m.ensurePromise = null;
    }
  })();
  return m.ensurePromise;
}

/** TEST helper — wipe all machines (do not call in production code). */
export function __resetForTests(): void {
  machines.clear();
}
