/**
 * Current device identity (multi-device E2EE).
 *
 * Stable per-browser identifier persisted in localStorage with a tiered fallback
 * chain so it survives:
 *   1. Normal browsers       → localStorage  (persistent across sessions)
 *   2. iOS PWA / Safari ITP  → sessionStorage (persistent across reloads in tab)
 *   3. Strict private mode   → in-memory     (persistent for the JS lifetime)
 *
 * CRITICAL: once an id has been issued in this JS lifetime, we NEVER hand out a
 * different one — even if the underlying storage starts failing later. Switching
 * device_id mid-session would invalidate the Double Ratchet state and make all
 * incoming messages addressed to this device undecipherable.
 */

const STORAGE_KEY = 'forsure-device-id-v1';

// In-memory fallback that survives storage failures within a single JS lifetime.
let memoryDeviceId: string | null = null;

function generateId(): string {
  // 32-char hex (128 bits of entropy)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function safeRead(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWrite(storage: Storage | undefined, key: string, value: string): boolean {
  try {
    storage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function getCurrentDeviceId(): string {
  // 1. Already pinned for this JS lifetime — never change it.
  if (memoryDeviceId) return memoryDeviceId;

  const ls = typeof window !== 'undefined' ? window.localStorage : undefined;
  const ss = typeof window !== 'undefined' ? window.sessionStorage : undefined;

  // 2. Try persistent stores in order.
  let id = safeRead(ls, STORAGE_KEY) || safeRead(ss, STORAGE_KEY);

  // 3. None found → generate exactly once.
  if (!id) {
    id = generateId();
    console.log('[device-id] generated fresh id', id.slice(0, 8) + '…');
  } else {
    console.log('[device-id] restored existing id', id.slice(0, 8) + '…');
  }

  // 4. Try to persist; failures are non-fatal because memory still pins it.
  const persisted =
    safeWrite(ls, STORAGE_KEY, id) || safeWrite(ss, STORAGE_KEY, id);
  if (!persisted) {
    console.warn('[device-id] storage unavailable, keeping id in memory only');
  }

  memoryDeviceId = id;
  return id;
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
