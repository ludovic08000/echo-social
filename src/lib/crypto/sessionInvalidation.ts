import { invalidateLibsignalSessions } from './libsignalSessionFreshness';

let watcherStarted = false;

/**
 * Security-epoch changes require a fresh Libsignal handshake on the next send.
 * Existing receive state and trusted identities remain in the sealed store.
 */
export function startSessionInvalidationWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  const invalidate = (event: Event) => {
    const detail = (event as CustomEvent<{ userId?: string; reason?: string }>).detail;
    if (!detail?.userId) return;
    void invalidateLibsignalSessions(detail.userId).catch(error => {
      console.warn('[AEGIS] device-session invalidation failed', {
        reason: detail?.reason ?? 'security_state_changed',
        error,
      });
    });
  };

  window.addEventListener('forsure-e2ee-security-epoch-changed', invalidate);
  window.addEventListener('forsure-e2ee-security-code-changed', invalidate);
}
