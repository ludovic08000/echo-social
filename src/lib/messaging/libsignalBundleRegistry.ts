import { supabase } from '@/integrations/supabase/client';
import { libSignalNative, type LibSignalDeviceBundle } from '@/lib/libsignalNative';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';

export async function publishCurrentLibSignalBundle(userId: string): Promise<LibSignalDeviceBundle> {
  const deviceId = getCurrentDeviceId();
  const bundle = await libSignalNative.ensureDevice({ userId, deviceId });
  const { error } = await supabase.rpc('publish_libsignal_device_bundle' as never, {
    p_device_id: deviceId,
    p_bundle: bundle,
  } as never);
  if (error) throw new Error(`LIBSIGNAL_BUNDLE_PUBLISH_FAILED:${error.message}`);
  return bundle;
}

export async function claimLibSignalBundle(userId: string, deviceId: string): Promise<LibSignalDeviceBundle> {
  const { data, error } = await supabase.rpc('claim_libsignal_device_bundle' as never, {
    p_user_id: userId,
    p_device_id: deviceId,
  } as never);
  if (error) throw new Error(`LIBSIGNAL_BUNDLE_CLAIM_FAILED:${error.message}`);
  const raw: unknown = data;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row) throw new Error('LIBSIGNAL_BUNDLE_UNAVAILABLE');
  return row as unknown as LibSignalDeviceBundle;
}
