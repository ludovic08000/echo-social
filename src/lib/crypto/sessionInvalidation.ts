import { clearAllDeviceSessions } from './deviceRatchet';

let watcherStarted = false;

/**
 * Security-epoch changes invalidate only Sesame-lite device-pair sessions.
 * The next send establishes fresh X3DH v3 sessions for every target device.
 */
export function startSessionInvalidationWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  const invalidate = (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    void clearAllDeviceSessions().catch(error => {
      console.warn('[SESAME_LITE] device-session invalidation failed', {
        reason: detail?.reason ?? 'security_state_changed',
        error,
      });
    });
  };

  window.addEventListener('forsure-e2ee-security-epoch-changed', invalidate);
  window.addEventListener('forsure-e2ee-security-code-changed', invalidate);
}
