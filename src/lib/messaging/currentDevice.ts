/**
 * Current device identity (multi-device E2EE).
 *
 * Stable per-browser identifier persisted in localStorage.
 * Used to:
 *  - register the device in `user_devices` at login
 *  - tag outgoing message copies (sender_device_id)
 *  - fetch incoming copies addressed to this device
 *
 * NOTE: this is NOT a cryptographic identity by itself — it's a routing label.
 * The actual E2EE key material lives in IndexedDB (ratchet states, identity keys).
 */

const STORAGE_KEY = 'forsure-device-id-v1';
let memoryDeviceId: string | null = null;

function generateId(): string {
  // 22-char URL-safe random (128 bits of entropy)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function getCurrentDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;

  const persistEverywhere = (id: string) => {
    memoryDeviceId = id;
    try { localStorage.setItem(STORAGE_KEY, id); } catch {}
    try { sessionStorage.setItem(STORAGE_KEY, id); } catch {}
    return id;
  };

  try {
    const localId = localStorage.getItem(STORAGE_KEY);
    if (localId) return persistEverywhere(localId);
  } catch {}

  try {
    const sessionId = sessionStorage.getItem(STORAGE_KEY);
    if (sessionId) return persistEverywhere(sessionId);
  } catch {}

  // Last-resort fallback: create ONCE in memory and reuse for the whole runtime.
  return persistEverywhere(generateId());
}

/** Best-effort device label for the user_devices registry */
export function getCurrentDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown device';
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

export function getCurrentPlatform(): string {
  if (typeof navigator === 'undefined') return 'web';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'web';
}
