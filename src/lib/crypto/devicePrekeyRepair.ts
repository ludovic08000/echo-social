import { supabase } from '@/integrations/supabase/client';
import { provisionLibsignalDevice } from './libsignalProvisioning';

export async function repairCurrentDevicePrekeys(
  userId: string,
  deviceId: string,
  signingPrivateKey: CryptoKey,
  reason: string,
): Promise<{ repaired: boolean; reason: string }> {
  try {
    const { data: deviceRow, error } = await supabase
      .from('user_devices')
      .select('is_active,revoked_at')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (!error && deviceRow && (deviceRow.is_active === false || deviceRow.revoked_at)) {
      console.warn('[X3DH-REPAIR] skipped revoked/inactive device prekey repair', {
        userId,
        deviceId,
        reason,
      });
      return { repaired: false, reason: 'device-revoked-or-inactive' };
    }
  } catch (lookupErr) {
    console.warn('[X3DH-REPAIR] device lifecycle lookup failed (non-fatal):', lookupErr);
  }

  console.warn('[LIBSIGNAL-REPAIR] repairing current device prekeys', {
    userId,
    deviceId,
    reason,
  });

  void signingPrivateKey;
  await provisionLibsignalDevice(userId, deviceId);

  try {
    window.dispatchEvent(new CustomEvent('forsure-device-prekeys-repaired', {
      detail: { userId, deviceId, reason },
    }));
  } catch {}

  return { repaired: true, reason };
}
