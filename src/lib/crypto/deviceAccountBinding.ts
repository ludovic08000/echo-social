import { supabase } from '@/integrations/supabase/client';
import { prepareDeviceAuthorization, loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { loadDeviceKxKey } from '@/lib/crypto/deviceKx';

type DeviceBindingRow = {
  device_id: string;
  device_public_key: string | null;
  device_signing_key: string | null;
  approval_status: string | null;
  is_active: boolean | null;
  revoked_at: string | null;
  binding_status: string | null;
  device_authorization_signature: string | null;
};

export async function bindApprovedDeviceToAccount(
  userId: string,
  deviceId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) throw new Error(`DEVICE_BINDING_LOOKUP_FAILED:${error.message}`);
  if (!data) throw new Error('DEVICE_NOT_FOUND');
  const row = data as unknown as DeviceBindingRow;

  if (row.revoked_at || row.approval_status !== 'approved' || row.is_active !== true) {
    throw new Error('DEVICE_NOT_APPROVED');
  }
  if (row.binding_status === 'bound' && row.device_authorization_signature) return;

  const [identity, kx] = await Promise.all([
    loadDeviceIdentity(userId, deviceId),
    loadDeviceKxKey(deviceId, userId),
  ]);
  if (!identity || !kx) throw new Error('DEVICE_LOCAL_PRIVATE_KEYS_MISSING');
  if (identity.publicB64 !== row.device_signing_key || kx.publicB64 !== row.device_public_key) {
    throw new Error('DEVICE_LOCAL_KEY_MISMATCH');
  }

  const authorization = await prepareDeviceAuthorization(userId, deviceId, kx);
  if (
    authorization.deviceSigning.publicB64 !== identity.publicB64
    || authorization.deviceKx.publicB64 !== kx.publicB64
  ) {
    throw new Error('DEVICE_AUTHORIZATION_LOCAL_KEY_MISMATCH');
  }

  const { data: resultData, error: invokeError } = await supabase.functions.invoke('approve-device-enrollment', {
    body: {
      action: 'bind',
      device_id: deviceId,
      device_authorization_signature: authorization.authorizationSignature,
    },
  });
  if (invokeError) throw new Error(`DEVICE_ACCOUNT_BIND_FAILED:${invokeError.message}`);

  const result = resultData as Record<string, unknown> | null;
  if (!result || result.ok !== true || result.code !== 'DEVICE_ACCOUNT_BOUND' || result.device_id !== deviceId) {
    throw new Error(typeof result?.code === 'string' ? result.code : 'DEVICE_ACCOUNT_BIND_REJECTED');
  }
}
