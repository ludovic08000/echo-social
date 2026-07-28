/**
 * Runtime security bootstrap.
 *
 * Security controls that mutate browser globals are intentionally avoided here.
 * Replacing or freezing fetch/XHR/WebSocket, timers, constructors or built-in
 * prototypes can break Supabase, LiveKit, browser extensions and framework
 * internals. Network restrictions belong in CSP and server response headers;
 * cryptographic integrity checks remain scoped to the crypto module.
 */

let activated = false;

export function activateRuntimeShield(): void {
  if (activated || typeof window === 'undefined') return;
  activated = true;

  if (import.meta.env.DEV) return;

  const isLocalhost =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '[::1]';

  if (window.location.protocol !== 'https:' && !isLocalhost) {
    console.warn('[SECURITY] Application loaded without HTTPS');
  }
}
