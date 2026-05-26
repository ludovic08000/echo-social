import { supabase } from '@/integrations/supabase/client';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';

const STORE_KEY = 'forsure:e2ee:crypto-invalid-devices:v1';
const DEFAULT_INVALID_TTL_MS = 15 * 60 * 1000;
const PERMANENT_INVALID_EXPIRES_AT = 8_640_000_000_000_000;

export const KNOWN_INVALID_DEVICE_IDS = [
  '84aaa52143235807214bf3aa161dd03a',
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8',
] as const;

const KNOWN_INVALID_DEVICE_ID_SET = new Set<string>(KNOWN_INVALID_DEVICE_IDS);

export interface CryptoInvalidDeviceRecord {
  userId: string;
  deviceId: string;
  reason: string;
  markedAt: number;
  expiresAt: number;
}

function recordKey(userId: string, deviceId: string): string {
  return `${userId}::${deviceId}`;
}

export function isKnownInvalidDeviceId(deviceId: string): boolean {
  return !!deviceId && KNOWN_INVALID_DEVICE_ID_SET.has(deviceId);
}

export function isInvalidDeviceId(deviceId: string): boolean {
  if (isKnownInvalidDeviceId(deviceId)) return true;
  if (!deviceId) return false;
  const records = pruneExpired();
  return Object.values(records).some(record => record?.deviceId === deviceId);
}

function readRecords(): Record<string, CryptoInvalidDeviceRecord> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRecords(records: Record<string, CryptoInvalidDeviceRecord>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(records));
  } catch {
    // Local-only optimisation; never block crypto flows on storage errors.
  }
}

function pruneExpired(records = readRecords(), now = Date.now()): Record<string, CryptoInvalidDeviceRecord> {
  let changed = false;
  for (const [key, record] of Object.entries(records)) {
    if (!record || record.expiresAt <= now) {
      delete records[key];
      changed = true;
    }
  }
  if (changed) writeRecords(records);
  return records;
}

export function getDeviceCryptoInvalid(
  userId: string,
  deviceId: string,
): CryptoInvalidDeviceRecord | null {
  if (!userId || !deviceId) return null;
  if (isKnownInvalidDeviceId(deviceId)) {
    return {
      userId,
      deviceId,
      reason: 'known_invalid_device_quarantine',
      markedAt: 0,
      expiresAt: PERMANENT_INVALID_EXPIRES_AT,
    };
  }
  const records = pruneExpired();
  return records[recordKey(userId, deviceId)] ?? null;
}

export function isDeviceCryptoInvalid(userId: string, deviceId: string): boolean {
  return !!getDeviceCryptoInvalid(userId, deviceId);
}

export function markDeviceCryptoInvalid(
  userId: string,
  deviceId: string,
  reason: string,
  ttlMs = DEFAULT_INVALID_TTL_MS,
): CryptoInvalidDeviceRecord | null {
  if (!userId || !deviceId) return null;

  const now = Date.now();
  const record: CryptoInvalidDeviceRecord = {
    userId,
    deviceId,
    reason,
    markedAt: now,
    expiresAt: now + Math.max(60_000, ttlMs),
  };

  const records = pruneExpired(readRecords(), now);
  records[recordKey(userId, deviceId)] = record;
  writeRecords(records);

  logCryptoError({
    severity: 'warning',
    context: 'key.fetch',
    errorCode: 'DEVICE_CRYPTO_INVALID_LOCAL',
    errorMessage: 'Device marked crypto-invalid locally and excluded from fanout temporarily',
    peerUserId: userId,
    peerDeviceId: deviceId,
    metadata: { reason, expiresAt: new Date(record.expiresAt).toISOString() },
  });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-device-prekey-invalid', {
      detail: record,
    }));
  }

  return record;
}

export function clearDeviceCryptoInvalid(userId: string, deviceId: string): void {
  if (!userId || !deviceId) return;
  const records = readRecords();
  const key = recordKey(userId, deviceId);
  if (!records[key]) return;
  delete records[key];
  writeRecords(records);
}

export async function requestDevicePrekeyRepair(
  userId: string,
  deviceId: string,
  reason: string,
): Promise<boolean> {
  if (!userId || !deviceId) return false;
  try {
    const { error } = await supabase.rpc('request_device_prekey_repair' as any, {
      p_user_id: userId,
      p_device_id: deviceId,
      p_reason: reason,
    });
    if (!error) return true;
    const missingRpc = error.code === 'PGRST202' || /function .*not.*found|schema cache/i.test(error.message ?? '');
    if (!missingRpc) {
      logCryptoError({
        severity: 'warning',
        context: 'key.fetch',
        errorCode: 'DEVICE_PREKEY_REPAIR_REQUEST_FAILED',
        errorMessage: error.message ?? 'Device prekey repair request failed',
        peerUserId: userId,
        peerDeviceId: deviceId,
        metadata: { reason },
      });
    }
    return false;
  } catch (e) {
    logCryptoException('key.fetch', e, {
      severity: 'warning',
      peerUserId: userId,
      peerDeviceId: deviceId,
      metadata: { stage: 'requestDevicePrekeyRepair', reason },
    });
    return false;
  }
}
