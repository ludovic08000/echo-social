/**
 * Device registry façade — wraps the existing per-device key publishing
 * (`useDeviceRegistration` + `list_active_devices_for_user` RPC) into a
 * Sesame-style API: "give me all devices of user X".
 *
 * No new tables are created. The Supabase RPC `list_active_devices_for_user`
 * already returns the canonical device list with `device_public_key`.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import { logCryptoError } from '@/lib/crypto/errorLogger';
import {
  getDeviceCryptoInvalid,
  requestDevicePrekeyRepair,
} from '@/lib/messaging/deviceCryptoInvalid';
import type { DeviceDescriptor, UserId, DeviceId } from './types';

const STALE_DEVICE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

type DeviceRow = {
  device_id?: string | null;
  device_public_key?: string | null;
  last_seen?: string | null;
  last_seen_at?: string | null;
  is_active?: boolean | null;
  revoked_at?: string | null;
  stale_at?: string | null;
};

/** Stable device id of the current installation. Persisted in Keychain on iOS. */
export function selfDeviceId(): DeviceId {
  return getCurrentDeviceId();
}

/**
 * True when `selfDeviceId()` is still a hydration-pending fallback. Callers
 * that would otherwise pin a long-lived session (X3DH respond, ratchet
 * establish) should wait for `hydrateDeviceId()` to complete first.
 */
export function isSelfDeviceIdTemporary(): boolean {
  return isDeviceIdTemporary();
}

function parseTime(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeDeviceRow(userId: UserId, row: DeviceRow): DeviceDescriptor | null {
  if (!row.device_id || !row.device_public_key) return null;
  return {
    userId,
    deviceId: row.device_id,
    devicePublicKey: row.device_public_key,
    lastSeen: parseTime(row.last_seen_at ?? row.last_seen),
    isActive: row.is_active ?? undefined,
    revokedAt: parseTime(row.revoked_at) ?? null,
    staleAt: parseTime(row.stale_at) ?? null,
  };
}

export function isDeviceStale(device: DeviceDescriptor, now = Date.now()): boolean {
  if (!device.devicePublicKey) return true;
  if (device.revokedAt !== undefined && device.revokedAt !== null) return true;
  if (device.staleAt !== undefined && device.staleAt !== null) return true;
  if (device.isActive === false) return true;
  if (device.signatureInvalid === true) return true;
  if (device.hasActiveSignedPrekey === false) return true;
  if (device.lastSeen !== undefined && now - device.lastSeen > STALE_DEVICE_AFTER_MS) return true;
  return false;
}

function logSkippedDevice(device: DeviceDescriptor, reason: string): void {
  logCryptoError({
    severity: 'info',
    context: 'fanout',
    errorCode: 'E_SKIP_STALE_DEVICE',
    errorMessage: 'Skipped stale, revoked, duplicate, or SPK-less device',
    peerUserId: device.userId,
    peerDeviceId: device.deviceId,
    metadata: {
      reason,
      lastSeen: device.lastSeen,
      revokedAt: device.revokedAt,
      staleAt: device.staleAt,
      isActive: device.isActive,
      hasActiveSignedPrekey: device.hasActiveSignedPrekey,
      signatureInvalid: device.signatureInvalid,
    },
  });
}

async function markDeviceStaleOnServer(device: DeviceDescriptor, reason: string): Promise<void> {
  try {
    const auth = (supabase as any).auth;
    const { data } = auth?.getUser ? await auth.getUser() : { data: null };
    if (data?.user?.id !== device.userId) return;

    const staleAt = new Date().toISOString();
    const payloads: Array<Record<string, unknown>> = [
      { is_active: false, stale_at: staleAt, revoke_reason: reason },
      { is_active: false, stale_at: staleAt },
    ];

    for (const payload of payloads) {
      const { error } = await supabase
        .from('user_devices')
        .update(payload as any)
        .eq('user_id', device.userId)
        .eq('device_id', device.deviceId);
      if (!error) return;
    }
  } catch {
    // Best effort only: RLS may reject updates for devices owned by another user.
  }
}

function dedupeByRecentLastSeen(devices: DeviceDescriptor[]): DeviceDescriptor[] {
  const sorted = [...devices].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  const seen = new Set<string>();
  const out: DeviceDescriptor[] = [];
  for (const device of sorted) {
    const key = `${device.userId}:${device.deviceId}`;
    if (seen.has(key)) {
      logSkippedDevice(device, 'duplicate_device_id');
      continue;
    }
    seen.add(key);
    out.push(device);
  }
  return out;
}

async function loadDeviceLifecycle(device: DeviceDescriptor): Promise<DeviceDescriptor> {
  try {
    const { data } = await supabase
      .from('user_devices')
      .select('device_id, device_public_key, is_active, revoked_at, stale_at, last_seen_at')
      .eq('user_id', device.userId)
      .eq('device_id', device.deviceId)
      .maybeSingle();
    const normalized = normalizeDeviceRow(device.userId, (data ?? {}) as DeviceRow);
    return normalized ? { ...device, ...normalized } : device;
  } catch {
    return device;
  }
}

async function withVerifiedSignedPrekey(device: DeviceDescriptor): Promise<DeviceDescriptor> {
  const invalid = getDeviceCryptoInvalid(device.userId, device.deviceId);
  if (invalid) {
    void requestDevicePrekeyRepair(device.userId, device.deviceId, invalid.reason);
    return {
      ...device,
      hasActiveSignedPrekey: false,
      signatureInvalid: true,
    };
  }

  const spk = await peekDeviceSignedPrekey(device.userId, device.deviceId).catch(() => null);
  return {
    ...device,
    hasActiveSignedPrekey: !!spk,
    signatureInvalid: !spk,
  };
}

/**
 * List every active device of `userId`. Never throws — returns [] on RPC error
 * so the caller can fall back to the single-device path.
 */
export async function listDevicesForUser(userId: UserId): Promise<DeviceDescriptor[]> {
  try {
    const { data, error } = await supabase.rpc('list_active_devices_for_user', {
      p_user_id: userId,
    });
    if (error || !data) return [];

    const candidates = dedupeByRecentLastSeen(
      (data as DeviceRow[])
        .map(row => normalizeDeviceRow(userId, row))
        .filter((d): d is DeviceDescriptor => !!d),
    );

    const out: DeviceDescriptor[] = [];
    for (const candidate of candidates) {
      const lifecycle = await loadDeviceLifecycle(candidate);
      if (isDeviceStale(lifecycle)) {
        logSkippedDevice(lifecycle, 'lifecycle_stale');
        continue;
      }

      const verified = await withVerifiedSignedPrekey(lifecycle);
      if (isDeviceStale(verified)) {
        const reason = verified.hasActiveSignedPrekey === false ? 'missing_or_invalid_spk' : 'stale';
        if (verified.hasActiveSignedPrekey === false) {
          void markDeviceStaleOnServer(verified, reason);
        }
        logSkippedDevice(verified, reason);
        continue;
      }
      out.push(verified);
    }

    return out.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  } catch {
    return [];
  }
}

export async function resolveActiveDeviceDescriptor(
  device: DeviceDescriptor,
): Promise<DeviceDescriptor | null> {
  const candidates = await listDevicesForUser(device.userId);
  const active = candidates.find(d => d.deviceId === device.deviceId);
  if (active) return active;

  const lifecycle = await loadDeviceLifecycle(device);
  if (isDeviceStale(lifecycle)) return null;
  const verified = await withVerifiedSignedPrekey(lifecycle);
  if (isDeviceStale(verified)) {
    if (verified.hasActiveSignedPrekey === false) {
      void markDeviceStaleOnServer(verified, 'missing_or_invalid_spk');
    }
    return null;
  }
  return verified;
}

/**
 * List every device that should receive a copy of a message sent by
 * `senderUserId` to `recipientUserIds`. Excludes the sender's CURRENT device
 * (it already keeps the plaintext locally) but INCLUDES the sender's other
 * devices so they sync the conversation.
 */
export async function listFanoutTargets(
  senderUserId: UserId,
  recipientUserIds: UserId[],
): Promise<DeviceDescriptor[]> {
  const me = selfDeviceId();
  const userIds = Array.from(new Set([...recipientUserIds, senderUserId]));
  const lists = await Promise.all(userIds.map(listDevicesForUser));
  return lists
    .flat()
    .filter(d => !(d.userId === senderUserId && d.deviceId === me));
}
