import { supabase } from '@/integrations/supabase/client';
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

/**
 * Reactivate/approve the SAME stable DeviceID after PIN/key restore. Never
 * creates a replacement ID. A deliberate rejection remains blocked.
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

  if (lifecycle.state === 'pending' || lifecycle.state === 'inactive' || lifecycle.state === 'revoked') {
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

  return lifecycle;
}
