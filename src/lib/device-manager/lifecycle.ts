import { supabase } from '@/integrations/supabase/client';
import { loadIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto/keyManager';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import {
  getCurrentDeviceLabel,
  getCurrentPlatform,
  getDeviceFingerprint,
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
    getOrCreateDeviceKxKey(deviceId),
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

  const { data: rpcResult, error: rpcError } = await (supabase as any).rpc(
    'register_user_device_safe',
    args,
  );

  if (!rpcError && rpcResult?.ok === true) return;

  const code = String(rpcResult?.code ?? rpcResult?.message ?? rpcError?.message ?? '');
  if (/DEVICE_APPROVAL_PENDING/i.test(code)) return;
  if (/DEVICE_REJECTED|DEVICE_REVOKED_OR_REJECTED/i.test(code)) {
    throw new Error('DEVICE_REJECTED_REQUIRES_EXPLICIT_USER_ACTION');
  }

  // Compatibility path for databases where the safe RPC has not yet been
  // deployed. RLS still restricts this row to the authenticated account.
  const { error: upsertError } = await supabase.from('user_devices').upsert({
    user_id: userId,
    device_id: deviceId,
    device_name: getCurrentDeviceLabel(),
    device_public_key: devicePublicKey,
    device_fingerprint: fingerprint,
    platform: getCurrentPlatform(),
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
    is_active: true,
    last_seen_at: new Date().toISOString(),
  } as never, { onConflict: 'user_id,device_id' });
  if (upsertError) {
    throw new Error(`DEVICE_REGISTRATION_FAILED:${upsertError.message}`);
  }
}

/**
 * Restore the SAME physical DeviceID after PIN/key recovery. Missing rows are
 * created with the already-restored per-device X25519 key; pending/inactive/
 * revoked rows are re-approved. The function never invents a replacement ID.
 */
export async function recoverStableDeviceLifecycle(
  userId: string,
  deviceId: string,
): Promise<ManagedDeviceLifecycle> {
  await requireAuthenticatedDeviceSession(userId);
  let lifecycle = await readManagedDeviceLifecycle(userId, deviceId);

  if (lifecycle.state === 'rejected') {
    throw new Error('DEVICE_REJECTED_REQUIRES_EXPLICIT_USER_ACTION');
  }

  if (lifecycle.state === 'missing') {
    await registerMissingStableDevice(userId, deviceId);
    lifecycle = await readManagedDeviceLifecycle(userId, deviceId);
  }

  if (
    lifecycle.state === 'pending' ||
    lifecycle.state === 'inactive' ||
    lifecycle.state === 'revoked'
  ) {
    const { data, error } = await (supabase as any).rpc('approve_user_device', {
      p_device_id: deviceId,
    });
    if (error || data?.ok !== true) {
      console.warn('[DeviceManager] stable device reapproval failed', {
        deviceId: deviceId.slice(0, 8),
        state: lifecycle.state,
        error: error?.message ?? data?.code ?? 'unknown',
      });
      throw new Error(`DEVICE_REAPPROVAL_FAILED:${lifecycle.state}`);
    }
    lifecycle = await readManagedDeviceLifecycle(userId, deviceId);
  }

  if (lifecycle.state === 'missing') {
    throw new Error('DEVICE_REGISTRATION_NOT_VISIBLE_AFTER_WRITE');
  }

  return lifecycle;
}
