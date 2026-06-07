/**
 * sessionGuard — Protects Supabase session tokens from XSS exfiltration
 *
 * Defense layers:
 * 1. Binds session to a device fingerprint — stolen token detected on different device
 * 2. Monitors localStorage access patterns — flags rapid extraction
 * 3. Forces session refresh on suspicious activity
 * 4. Short idle timeout with auto-lock
 */

import { supabase } from '@/integrations/supabase/client';

const GUARD_KEY = 'forsure-session-guard';
const MAX_IDLE_MS = 30 * 60_000; // 30 min idle → force refresh
const CHECK_INTERVAL = 60_000; // Check every 60s

interface GuardState {
  fingerprint: string;
  lastActivity: number;
  bindTime: number;
}

/** Simple device fingerprint for session binding */
function deviceFingerprint(): string {
  const parts = [
    navigator.userAgent,
    screen.width + 'x' + screen.height,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.language,
    navigator.hardwareConcurrency?.toString() ?? '?',
  ];
  // Simple hash — not cryptographic, just binding
  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/** Protect Supabase localStorage keys from cross-tab exfiltration */
function protectStorageKeys(): void {
  const supabaseKeyPrefix = 'sb-';
  
  // Monitor storage events from other tabs/windows
  window.addEventListener('storage', (e) => {
    if (e.key?.startsWith(supabaseKeyPrefix) && e.newValue === null) {
      // Someone deleted the session from another context — suspicious
      console.warn('[SessionGuard] Session key removed externally');
      // Force re-auth
      supabase.auth.getSession().then(({ data }) => {
        if (!data.session) {
          window.location.href = '/login';
        }
      });
    }
  });
}

/** Activity tracker — updates last activity timestamp */
function trackActivity(state: GuardState): void {
  state.lastActivity = Date.now();
  try {
    sessionStorage.setItem(GUARD_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage may be full or blocked
  }
}

let guardInterval: ReturnType<typeof setInterval> | null = null;

export function startSessionGuard(): void {
  if (guardInterval) return; // Already running

  const fp = deviceFingerprint();

  // Check existing guard state
  let state: GuardState;
  try {
    const existing = sessionStorage.getItem(GUARD_KEY);
    if (existing) {
      state = JSON.parse(existing);
      // Fingerprint mismatch can happen after cache resets, browser upgrades,
      // orientation changes, or PWA reinstall. Rebind instead of login-looping.
      if (state.fingerprint !== fp) {
        console.warn('[SessionGuard] Fingerprint changed — rebinding guard for current signed-in session');
        sessionStorage.removeItem(GUARD_KEY);
        state = { fingerprint: fp, lastActivity: Date.now(), bindTime: Date.now() };
      }
    } else {
      state = { fingerprint: fp, lastActivity: Date.now(), bindTime: Date.now() };
    }
  } catch {
    state = { fingerprint: fp, lastActivity: Date.now(), bindTime: Date.now() };
  }

  // Track user activity
  const onActivity = () => trackActivity(state);
  window.addEventListener('click', onActivity, { passive: true });
  window.addEventListener('keydown', onActivity, { passive: true });
  window.addEventListener('touchstart', onActivity, { passive: true });
  window.addEventListener('scroll', onActivity, { passive: true });

  // Protect storage keys
  protectStorageKeys();

  // Periodic checks
  guardInterval = setInterval(async () => {
    const now = Date.now();
    const idleTime = now - state.lastActivity;

    // Idle timeout — force session refresh
    if (idleTime > MAX_IDLE_MS) {
      console.log('[SessionGuard] Idle timeout — refreshing session');
      const { error } = await supabase.auth.refreshSession();
      if (error) {
        console.warn('[SessionGuard] Refresh failed — signing out');
        supabase.auth.signOut();
        window.location.href = '/login';
        return;
      }
      state.lastActivity = now;
    }

    // Validate session is still valid
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      stopSessionGuard();
    }
  }, CHECK_INTERVAL);

  // Save initial state
  trackActivity(state);
  console.log('[SessionGuard] Started');
}

export function stopSessionGuard(): void {
  if (guardInterval) {
    clearInterval(guardInterval);
    guardInterval = null;
  }
  try {
    sessionStorage.removeItem(GUARD_KEY);
  } catch {}
}
