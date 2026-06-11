/**
 * iOS-safe UUID.
 * `crypto.randomUUID()` is unavailable on:
 *   - Safari < 15.4
 *   - non-secure contexts (some iOS PWA edge cases after WKWebView reset)
 *   - Web Workers when the page lost its secure context briefly
 * We always fall back to a 128-bit value derived from getRandomValues +
 * timestamp + Math.random — never block the message queue.
 */
export function safeUUID(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      // RFC4122 v4 layout
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
  } catch {
    /* fall through */
  }
  // Last-resort: not RFC compliant but unique enough for traceIds / localIds
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Short non-cryptographic id for traces / local-only ids. */
export function shortId(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
