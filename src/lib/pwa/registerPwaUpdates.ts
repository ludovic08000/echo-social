import { registerSW } from 'virtual:pwa-register';

const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

let registrationStarted = false;

export function registerPwaUpdates(): void {
  if (registrationStarted || typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  registrationStarted = true;

  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;

      const requestUpdate = () => {
        void registration.update().catch((error: unknown) => {
          console.warn('[PWA_UPDATE] service-worker update check failed', error);
        });
      };

      // Do not wait for the browser's update throttle: a security/auth fix
      // published by Lovable Cloud must replace a stale shell immediately.
      requestUpdate();
      window.setInterval(requestUpdate, UPDATE_INTERVAL_MS);
      window.addEventListener('online', requestUpdate);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) requestUpdate();
      });
    },
    onRegisterError(error) {
      console.error('[PWA_UPDATE] service-worker registration failed', error);
    },
  });
}
