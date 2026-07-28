/**
 * Session lifecycle guard.
 *
 * Supabase already owns token validation and refresh. This module adds only
 * lightweight idle refresh and cross-tab observation; it must never turn
 * unstable browser characteristics or transient network failures into a forced
 * logout.
 */

import { supabase } from '@/integrations/supabase/client';

const GUARD_KEY = 'forsure-session-guard';
const INSTALLATION_KEY = 'forsure-session-installation-id';
const MAX_IDLE_MS = 30 * 60_000;
const CHECK_INTERVAL = 60_000;

interface GuardState {
  installationId: string;
  lastActivity: number;
  bindTime: number;
}

let guardInterval: ReturnType<typeof setInterval> | null = null;
let removeListeners: (() => void) | null = null;
let consecutiveRefreshFailures = 0;

function generateInstallationId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function getOrCreateInstallationId(): string {
  try {
    const existing = localStorage.getItem(INSTALLATION_KEY);
    if (existing) return existing;
    const created = generateInstallationId();
    localStorage.setItem(INSTALLATION_KEY, created);
    return created;
  } catch {
    // Storage may be unavailable in private browsing. This value is used only
    // to avoid false positives, not as an authentication secret.
    return generateInstallationId();
  }
}

function readGuardState(): GuardState | null {
  try {
    const raw = sessionStorage.getItem(GUARD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GuardState>;
    if (
      typeof parsed.installationId !== 'string' ||
      typeof parsed.lastActivity !== 'number' ||
      typeof parsed.bindTime !== 'number'
    ) {
      return null;
    }
    return parsed as GuardState;
  } catch {
    return null;
  }
}

function persistGuardState(state: GuardState): void {
  try {
    sessionStorage.setItem(GUARD_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage can be blocked or full
  }
}

export function startSessionGuard(): void {
  if (guardInterval) return;

  const installationId = getOrCreateInstallationId();
  const previous = readGuardState();
  const now = Date.now();

  // Older builds fingerprinted screen size, timezone and language. Those
  // values change legitimately on phones and caused immediate false logouts.
  // Rebind locally instead of signing out a valid Supabase session.
  const state: GuardState = previous?.installationId === installationId
    ? previous
    : { installationId, lastActivity: now, bindTime: now };

  const onActivity = () => {
    state.lastActivity = Date.now();
    persistGuardState(state);
  };

  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith('sb-') || event.newValue !== null) return;
    // Supabase's own auth listener remains authoritative. This asynchronous
    // check merely helps it observe a logout performed in another tab.
    void supabase.auth.getSession().catch(() => undefined);
  };

  window.addEventListener('click', onActivity, { passive: true });
  window.addEventListener('keydown', onActivity, { passive: true });
  window.addEventListener('touchstart', onActivity, { passive: true });
  window.addEventListener('scroll', onActivity, { passive: true });
  window.addEventListener('storage', onStorage);

  removeListeners = () => {
    window.removeEventListener('click', onActivity);
    window.removeEventListener('keydown', onActivity);
    window.removeEventListener('touchstart', onActivity);
    window.removeEventListener('scroll', onActivity);
    window.removeEventListener('storage', onStorage);
  };

  guardInterval = setInterval(async () => {
    const checkAt = Date.now();
    const idleTime = checkAt - state.lastActivity;

    if (idleTime > MAX_IDLE_MS) {
      try {
        const { error } = await supabase.auth.refreshSession();
        if (error) {
          consecutiveRefreshFailures += 1;
          console.warn('[SessionGuard] Idle refresh failed; keeping the current session for Supabase to revalidate', {
            attempts: consecutiveRefreshFailures,
            message: error.message,
          });
        } else {
          consecutiveRefreshFailures = 0;
          state.lastActivity = checkAt;
          persistGuardState(state);
        }
      } catch (error) {
        consecutiveRefreshFailures += 1;
        console.warn('[SessionGuard] Idle refresh transport failure; no forced logout', error);
      }
    }

    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) stopSessionGuard();
    } catch {
      // A temporary network/storage failure is not proof that auth is invalid.
    }
  }, CHECK_INTERVAL);

  persistGuardState(state);
  console.log('[SessionGuard] Started');
}

export function stopSessionGuard(): void {
  if (guardInterval) {
    clearInterval(guardInterval);
    guardInterval = null;
  }

  removeListeners?.();
  removeListeners = null;
  consecutiveRefreshFailures = 0;

  try {
    sessionStorage.removeItem(GUARD_KEY);
  } catch {
    // storage can be unavailable
  }
}

export const __test__ = {
  guardKey: GUARD_KEY,
  installationKey: INSTALLATION_KEY,
};
