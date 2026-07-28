const RECOVERY_FLAG = 'forsure-recovery-pending';
const RECOVERY_TTL_MS = 30 * 60_000;

type RecoveryState = {
  createdAt: number;
};

function getLocationHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

function getLocationPathname(): string {
  return typeof window === 'undefined' ? '' : window.location.pathname;
}

function readRecoveryState(): RecoveryState | null {
  if (typeof sessionStorage === 'undefined') return null;

  const raw = sessionStorage.getItem(RECOVERY_FLAG);
  if (!raw) return null;

  // Legacy builds stored a permanent "1" marker. Keep it only while the user
  // is actually on the recovery route; otherwise it can lock normal login.
  if (raw === '1') {
    if (getLocationPathname() === '/reset-password' || hasRecoveryHash()) {
      return { createdAt: Date.now() };
    }
    clearRecoveryFlag();
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryState>;
    if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) {
      clearRecoveryFlag();
      return null;
    }
    return { createdAt: parsed.createdAt };
  } catch {
    clearRecoveryFlag();
    return null;
  }
}

export function hasRecoveryHash(hash = getLocationHash()): boolean {
  // Only detect actual recovery flows — NOT generic token URLs (email confirm,
  // magic link, OAuth callback, etc.).
  return hash.includes('type=recovery');
}

export function setRecoveryFlag(now = Date.now()): void {
  try {
    sessionStorage.setItem(RECOVERY_FLAG, JSON.stringify({ createdAt: now } satisfies RecoveryState));
  } catch {
    // sessionStorage can be blocked in private browsing. The URL hash and
    // PASSWORD_RECOVERY event still keep the active flow functional.
  }
}

export function clearRecoveryFlag(): void {
  try {
    sessionStorage.removeItem(RECOVERY_FLAG);
  } catch {
    // storage can be unavailable
  }
}

export function isRecoveryPending(now = Date.now()): boolean {
  if (hasRecoveryHash()) return true;

  // Explicit password login must always be reachable. A recovery flow starts
  // from its dedicated URL, never from the normal login route.
  if (getLocationPathname() === '/login') {
    clearRecoveryFlag();
    return false;
  }

  const state = readRecoveryState();
  if (!state) return false;

  const age = now - state.createdAt;
  if (!Number.isFinite(age) || age < 0 || age > RECOVERY_TTL_MS) {
    clearRecoveryFlag();
    return false;
  }

  return true;
}

export function detectAndStoreRecoveryFromHash(hash = getLocationHash()): boolean {
  const detected = hasRecoveryHash(hash);

  if (detected) {
    setRecoveryFlag();
  }

  return detected;
}

/** Clear abandoned recovery state before a normal email/password sign-in. */
export function prepareNormalSignIn(): void {
  if (!hasRecoveryHash() && getLocationPathname() !== '/reset-password') {
    clearRecoveryFlag();
  }
}

export const __test__ = {
  recoveryFlag: RECOVERY_FLAG,
  recoveryTtlMs: RECOVERY_TTL_MS,
};
