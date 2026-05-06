import { hardCrypto } from './cryptoIntegrity';

export interface TrustedDeviceRecord {
  deviceId: string;
  userId: string;
  fingerprint: string;
  signedBy?: string;
  trustLevel: 'trusted' | 'unverified' | 'revoked';
  createdAt: number;
  lastSeenAt: number;
}

const STORE = 'forsure-device-trust';

function key(userId: string, deviceId: string) {
  return `${STORE}:${userId}:${deviceId}`;
}

export async function generateDeviceId(): Promise<string> {
  const bytes = hardCrypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function saveTrustedDevice(record: TrustedDeviceRecord): void {
  localStorage.setItem(key(record.userId, record.deviceId), JSON.stringify(record));
}

export function loadTrustedDevice(userId: string, deviceId: string): TrustedDeviceRecord | null {
  const raw = localStorage.getItem(key(userId, deviceId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as TrustedDeviceRecord;
  } catch {
    return null;
  }
}

export function revokeTrustedDevice(userId: string, deviceId: string): void {
  const existing = loadTrustedDevice(userId, deviceId);
  if (!existing) return;

  existing.trustLevel = 'revoked';
  existing.lastSeenAt = Date.now();
  saveTrustedDevice(existing);
}

export function listTrustedDevices(userId: string): TrustedDeviceRecord[] {
  const out: TrustedDeviceRecord[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(`${STORE}:${userId}:`)) continue;

    try {
      const parsed = JSON.parse(localStorage.getItem(k) || 'null');
      if (parsed) out.push(parsed);
    } catch {}
  }

  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
