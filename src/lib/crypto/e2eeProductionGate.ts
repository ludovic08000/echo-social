import { fetchServerIdentityState, assertLocalIdentityMatchesServer } from '@/lib/crypto/keyManager';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { assertAccountDeviceIsolation } from '@/lib/messaging/multiDeviceProtocolHardening';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';

export type E2EEProductionGateStatus =
  | 'READY'
  | 'BLOCKED_NO_SERVER_IDENTITY'
  | 'BLOCKED_TEMP_DEVICE_ID'
  | 'BLOCKED_ACCOUNT_DEVICE_SWITCH'
  | 'BLOCKED_FINGERPRINT_MISMATCH'
  | 'BLOCKED_UNKNOWN';

export interface E2EEProductionGateResult {
  ok: boolean;
  status: E2EEProductionGateStatus;
  userId: string;
  deviceId: string;
  serverFingerprint?: string | null;
  reason?: string;
}

/**
 * Final pre-send / pre-sync safety gate.
 *
 * This is intentionally strict:
 * - identity must exist server-side;
 * - local restored identity must match server fingerprint;
 * - temporary device ids are refused;
 * - account/device switches are detected before crypto state reuse.
 *
 * This gate DOES NOT create identity keys. Creation remains FIRST_SETUP only.
 */
export async function assertE2EEProductionReady(userId: string): Promise<E2EEProductionGateResult> {
  const deviceId = getCurrentDeviceId();

  try {
    if (isDeviceIdTemporary()) {
      return { ok: false, status: 'BLOCKED_TEMP_DEVICE_ID', userId, deviceId, reason: 'temporary_device_id' };
    }

    const isolation = assertAccountDeviceIsolation(userId);
    if (!isolation.ok) {
      logCryptoError({
        severity: 'critical',
        context: 'production-gate',
        errorCode: 'ACCOUNT_DEVICE_ISOLATION_BLOCK',
        errorMessage: 'Account/device switch detected before E2EE operation',
        myDeviceId: deviceId,
        metadata: { previous: isolation.previous, current: isolation.current },
      });
      return { ok: false, status: 'BLOCKED_ACCOUNT_DEVICE_SWITCH', userId, deviceId, reason: 'account_device_switch' };
    }

    const serverIdentity = await fetchServerIdentityState(userId);
    if (!serverIdentity) {
      return { ok: false, status: 'BLOCKED_NO_SERVER_IDENTITY', userId, deviceId, reason: 'missing_server_identity' };
    }

    await assertLocalIdentityMatchesServer(userId);

    return {
      ok: true,
      status: 'READY',
      userId,
      deviceId,
      serverFingerprint: serverIdentity.fingerprint,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logCryptoException('production-gate', error, {
      severity: 'critical',
      myDeviceId: deviceId,
      metadata: { userId, stage: 'assertE2EEProductionReady' },
    });
    return {
      ok: false,
      status: message.toLowerCase().includes('fingerprint') ? 'BLOCKED_FINGERPRINT_MISMATCH' : 'BLOCKED_UNKNOWN',
      userId,
      deviceId,
      reason: message,
    };
  }
}
