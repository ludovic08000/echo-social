const INVALID_DEVICE_STORE_KEY = 'forsure:invalid-device-spk-cache:v1';

const BUILTIN_INVALID_DEVICE_IDS = new Set<string>([
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8',
]);

// IDs previously flagged invalid but now back in legitimate use — strip from
// any persisted local cache so they stop being skipped during fan-out.
const REHABILITATED_DEVICE_IDS = new Set<string>([
  '84aaa52143235807214bf3aa161dd03a',
]);

try {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(INVALID_DEVICE_STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const cleaned = arr.filter((id: unknown) => typeof id === 'string' && !REHABILITATED_DEVICE_IDS.has(id));
        if (cleaned.length !== arr.length) {
          localStorage.setItem(INVALID_DEVICE_STORE_KEY, JSON.stringify(cleaned));
        }
      }
    }
  }
} catch {}

export function loadInvalidDeviceIds(): Set<string> {
  const out = new Set(BUILTIN_INVALID_DEVICE_IDS);
  try {
    if (typeof localStorage === 'undefined') return out;
    const raw = localStorage.getItem(INVALID_DEVICE_STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      for (const id of arr) if (typeof id === 'string' && id.length >= 8) out.add(id);
    }
  } catch {}
  return out;
}

export function isInvalidDeviceId(deviceId?: string | null): boolean {
  return !!deviceId && loadInvalidDeviceIds().has(deviceId);
}

export function markInvalidDeviceId(deviceId?: string | null): void {
  if (!deviceId || deviceId.length < 8) return;
  try {
    if (typeof localStorage === 'undefined') return;
    const set = loadInvalidDeviceIds();
    set.add(deviceId);
    localStorage.setItem(INVALID_DEVICE_STORE_KEY, JSON.stringify([...set].slice(-250)));
  } catch {}
}

export function clearInvalidDeviceCache(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(INVALID_DEVICE_STORE_KEY);
  } catch {}
}
