import { hardCrypto } from './cryptoIntegrity';

export interface TrustedDeviceRecord {
  deviceId: string;
  userId: string;
  fingerprint: string;
  /** Fingerprint of the already-trusted device/account key that approved this device. */
  signedBy?: string;
  trustLevel: 'trusted' | 'unverified' | 'revoked';
  createdAt: number;
  lastSeenAt: number;
}

const STORE = 'forsure-device-trust';

function key(userId: string, deviceId: string) {
  return `${STORE}:${userId}:${deviceId}`;
}

function isValidRecord(value: unknown): value is TrustedDeviceRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<TrustedDeviceRecord>;
  return typeof record.userId === 'string' && record.userId.length > 0 &&
    typeof record.deviceId === 'string' && record.deviceId.length >= 16 &&
    typeof record.fingerprint === 'string' && record.fingerprint.length > 0 &&
    (record.trustLevel === 'trusted' || record.trustLevel === 'unverified' || record.trustLevel === 'revoked') &&
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) &&
    typeof record.lastSeenAt === 'number' && Number.isFinite(record.lastSeenAt);
}

function normalizeRecord(record: TrustedDeviceRecord): TrustedDeviceRecord {
  // localStorage is only a cache and is writable by same-origin JavaScript. A
  // record without cryptographic provenance must never acquire trusted status
  // merely because the client wrote "trusted" into JSON.
  if (record.trustLevel === 'trusted' && !record.signedBy) {
    return { ...record, trustLevel: 'unverified' };
  }
  return record;
}

export async function generateDeviceId(): Promise<string> {
  const bytes = hardCrypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Persist a UI/cache representation of trust. This is not a cryptographic
 * authority; callers must verify a signed device manifest before passing
 * trustLevel="trusted" and signedBy.
 */
export function saveTrustedDevice(record: TrustedDeviceRecord): void {
  const normalized = normalizeRecord(record);
  localStorage.setItem(key(normalized.userId, normalized.deviceId), JSON.stringify(normalized));
}

export function loadTrustedDevice(userId: string, deviceId: string): TrustedDeviceRecord | null {
  const raw = localStorage.getItem(key(userId, deviceId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!isValidRecord(parsed)) return null;
    return normalizeRecord(parsed);
  } catch {
    return null;
  }
}

export function isCryptographicallyTrustedDevice(record: TrustedDeviceRecord | null | undefined): boolean {
  return !!record && record.trustLevel === 'trusted' && !!record.signedBy;
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
      if (isValidRecord(parsed)) out.push(normalizeRecord(parsed));
    } catch {
      // Ignore malformed cache entries; localStorage is not a trust authority.
    }
  }

  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
