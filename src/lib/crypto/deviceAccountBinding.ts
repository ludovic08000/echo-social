import { supabase } from '@/integrations/supabase/client';
import { prepareDeviceAuthorization, loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { runDeviceRpcWithTimeout } from '@/lib/api/deviceRpcTimeout';
import { traceDeviceKeyChecks, traceCurrentDeviceFinalization } from '@/lib/device-manager/deviceFinalizationTrace';

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
  if (row.binding_status === 'bound' && row.device_authorization_signature) {
    traceCurrentDeviceFinalization({ userId, deviceId, step: 'device_binding.already_bound', outcome: 'skipped' });
    return;
  }

  const [identity, kx] = await Promise.all([
    loadDeviceIdentity(userId, deviceId),
    loadDeviceKxKey(deviceId, userId),
  ]);
  traceDeviceKeyChecks({ userId, deviceId }, {
    signingPresent: Boolean(identity), exchangePresent: Boolean(kx),
    signingMatches: identity ? identity.publicB64 === row.device_signing_key : null,
    exchangeMatches: kx ? kx.publicB64 === row.device_public_key : null,
  });
  if (!identity || !kx) throw new Error('DEVICE_LOCAL_PRIVATE_KEYS_MISSING');
  if (identity.publicB64 !== row.device_signing_key || kx.publicB64 !== row.device_public_key) {
    throw new Error('DEVICE_LOCAL_KEY_MISMATCH');
  }

  const authorization = await prepareDeviceAuthorization(userId, deviceId, kx);
  traceCurrentDeviceFinalization({ userId, deviceId, step: 'device_binding.authorization_keys_match',
    outcome: authorization.deviceSigning.publicB64 === identity.publicB64 && authorization.deviceKx.publicB64 === kx.publicB64 ? 'success' : 'failure' });
  if (
    authorization.deviceSigning.publicB64 !== identity.publicB64
    || authorization.deviceKx.publicB64 !== kx.publicB64
  ) {
    throw new Error('DEVICE_AUTHORIZATION_LOCAL_KEY_MISMATCH');
  }

  const { data: resultData, error: rpcError } = await runDeviceRpcWithTimeout(
    'DEVICE_ACCOUNT_BIND_FAILED',
    (signal) => supabase.rpc(
      'bind_device_account' as never,
      {
        p_device_id: deviceId,
        p_device_authorization_signature: authorization.authorizationSignature,
      } as never,
    ).abortSignal(signal),
  );
  if (rpcError) {
    traceCurrentDeviceFinalization({ userId, deviceId, step: 'device_binding.server_result', outcome: 'failure', errorCode: rpcError.message });
    throw new Error(`DEVICE_ACCOUNT_BIND_FAILED:${rpcError.message}`);
  }

  const result = resultData as Record<string, unknown> | null;
  traceCurrentDeviceFinalization({ userId, deviceId, step: 'device_binding.server_result',
    outcome: result?.ok === true && result.code === 'DEVICE_ACCOUNT_BOUND' && result.device_id === deviceId ? 'success' : 'failure',
    errorCode: result?.ok === true && result.device_id !== deviceId ? 'DEVICE_BINDING_DEVICE_MISMATCH'
      : result?.ok === true ? undefined : result?.code });
  if (!result || result.ok !== true || result.code !== 'DEVICE_ACCOUNT_BOUND' || result.device_id !== deviceId) {
    throw new Error(typeof result?.code === 'string' ? result.code : 'DEVICE_ACCOUNT_BIND_REJECTED');
  }
}
