import { supabase } from '@/integrations/supabase/client';
import { loadIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto/keyManager';
import { deleteDeviceKxKey, getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import {
  getCurrentDeviceLabel,
  getCurrentPlatform,
  getDeviceFingerprint,
  rotateCurrentDeviceId,
} from './currentDevice';
import { requireAuthenticatedDeviceSession } from './sessionGate';

export type ManagedDeviceState =
  | 'missing'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'inactive';

export interface ManagedDeviceLifecycle {
  deviceId: string;
  state: ManagedDeviceState;
  isPrimary: boolean;
  devicePublicKey: string | null;
  replacedDeviceId?: string;
}

export async function readManagedDeviceLifecycle(
  userId: string,
  deviceId: string,
): Promise<ManagedDeviceLifecycle> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id,device_public_key,is_primary,is_active,approval_status,revoked_at')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { deviceId, state: 'missing', isPrimary: false, devicePublicKey: null };
  }

  let state: ManagedDeviceState;
  if (data.revoked_at) state = 'revoked';
  else if (data.is_active === false) state = 'inactive';
  else if (data.approval_status === 'pending') state = 'pending';
  else if (data.approval_status === 'rejected') state = 'rejected';
  else state = 'approved';

  return {
    deviceId,
    state,
    isPrimary: Boolean(data.is_primary),
    devicePublicKey: data.device_public_key ?? null,
  };
}

async function registerMissingStableDevice(
  userId: string,
  deviceId: string,
): Promise<void> {
  const identity = await loadIdentityKeys(userId);
  if (!identity?.privateKey || !identity.signingPrivateKey) {
    throw new Error('DEVICE_REGISTRATION_KEYS_NOT_UNLOCKED');
  }

  const [bundle, deviceKx, fingerprint] = await Promise.all([
    exportPublicKeyBundle(identity),
    getOrCreateDeviceKxKey(deviceId, userId),
    getDeviceFingerprint().catch(() => null),
  ]);
  const devicePublicKey = deviceKx?.publicB64 || bundle.identityKey;
  if (!devicePublicKey) throw new Error('DEVICE_REGISTRATION_PUBLIC_KEY_MISSING');

  const args = {
    p_user_id: userId,
    p_device_id: deviceId,
    p_device_name: getCurrentDeviceLabel(),
    p_device_public_key: devicePublicKey,
    p_device_fingerprint: fingerprint,
    p_platform: getCurrentPlatform(),
    p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
  };

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'register_user_device_safe',
    args,
  );
  const rpcResult = rpcData as { ok?: boolean; code?: string; message?: string } | null;

  if (!rpcError && rpcResult?.ok === true) return;

  const code = String(rpcResult?.code ?? rpcResult?.message ?? rpcError?.message ?? '');
  if (/DEVICE_APPROVAL_PENDING/i.test(code)) return;
  if (/DEVICE_REJECTED|DEVICE_REVOKED_OR_REJECTED/i.test(code)) {
    throw new Error('DEVICE_REJECTED_REQUIRES_EXPLICIT_USER_ACTION');
  }
  throw new Error(`DEVICE_REGISTRATION_RPC_REQUIRED:${code || 'UNKNOWN'}`);
}

/**
 * Recover the current installation after PIN unlock.
 *
 * - missing: register the same stable ID;
 * - pending/inactive: approve the existing ID;
 * - revoked: NEVER clear revoked_at. Retire that ID, mint one fresh ID exactly
 *   once, generate a fresh per-device X25519 key and enroll it normally.
 */
export async function recoverStableDeviceLifecycle(
  userId: string,
  deviceId: string,
): Promise<ManagedDeviceLifecycle> {
  await requireAuthenticatedDeviceSession(userId);
  let activeDeviceId = deviceId;
  let replacedDeviceId: string | undefined;
  let lifecycle = await readManagedDeviceLifecycle(userId, activeDeviceId);

  if (lifecycle.state === 'rejected') {
    throw new Error('DEVICE_REJECTED_REQUIRES_EXPLICIT_USER_ACTION');
  }

  if (lifecycle.state === 'revoked') {
    // Do not rotate before the PIN/account identity is actually available.
    const identity = await loadIdentityKeys(userId);
    if (!identity?.privateKey || !identity.signingPrivateKey) {
      throw new Error('DEVICE_REVOKED_PIN_UNLOCK_REQUIRED');
    }

    replacedDeviceId = activeDeviceId;
    const replacement = rotateCurrentDeviceId('revoked-reenrollment-after-pin');
    if (!replacement || replacement === replacedDeviceId) {
      throw new Error('DEVICE_REVOKED_REENROLLMENT_BLOCKED');
    }

    // The revoked transport key must never be reused locally.
    await deleteDeviceKxKey(replacedDeviceId, userId);
    activeDeviceId = replacement;
    lifecycle = await readManagedDeviceLifecycle(userId, activeDeviceId);

    console.warn('[DeviceManager] revoked device reenrollment started', {
      previous: replacedDeviceId.slice(0, 8),
      next: activeDeviceId.slice(0, 8),
    });
  }

  if (lifecycle.state === 'missing') {
    await registerMissingStableDevice(userId, activeDeviceId);
    lifecycle = await readManagedDeviceLifecycle(userId, activeDeviceId);
  }

  if (lifecycle.state === 'pending' || lifecycle.state === 'inactive') {
    const { data: approvalData, error } = await supabase.rpc('approve_user_device' as never, {
      p_device_id: activeDeviceId,
    } as never);
    const data = approvalData as { ok?: boolean; code?: string } | null;
    if (error || data?.ok !== true) {
      console.warn('[DeviceManager] device approval failed', {
        deviceId: activeDeviceId.slice(0, 8),
        state: lifecycle.state,
        error: error?.message ?? data?.code ?? 'unknown',
      });
      throw new Error(`DEVICE_REAPPROVAL_FAILED:${lifecycle.state}`);
    }
    lifecycle = await readManagedDeviceLifecycle(userId, activeDeviceId);
  }

  if (lifecycle.state !== 'approved') {
    throw new Error(`DEVICE_LIFECYCLE_NOT_APPROVED:${lifecycle.state}`);
  }

  return {
    ...lifecycle,
    deviceId: activeDeviceId,
    replacedDeviceId,
  };
}
