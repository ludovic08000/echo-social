import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import {
  beginExplicitDeviceEnrollment,
  getCurrentDeviceLabel,
  getCurrentPlatform,
  getDeviceFingerprint,
  setCurrentDeviceId,
  setCurrentDeviceUserScope,
} from '@/lib/messaging/currentDevice';
import {
  beginServerAssignedDeviceEnrollment,
  cancelServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollmentV2,
  type DeviceEnrollmentChallenge,
  type DevicePlatform,
} from '@/lib/crypto/serverDeviceEnrollment';
import {
  deleteDeviceIdentity,
  getOrCreateDeviceIdentity,
} from '@/lib/crypto/deviceIdentity';
import {
  deleteDeviceKxKey,
  getOrCreateDeviceKxKey,
} from '@/lib/crypto/deviceKx';
import {
  submitSelfDeviceApprovalDecision,
  type DeviceApprovalDecision,
} from '@/lib/crypto/deviceApprovalDecision';
import {
  computeDeviceApprovalFingerprint,
  formatDeviceApprovalFingerprint,
} from '@/lib/crypto/deviceApprovalFingerprint';

export interface PendingSelfApprovalDevice {
  deviceId: string;
  challengeId: string;
  deviceName: string;
  platform: string | null;
  devicePublicKey: string;
  deviceSigningKey: string;
  fingerprintLines: string[];
}

function normalizePlatform(value: unknown): DevicePlatform {
  const platform = String(value ?? '').toLowerCase();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

export function usePrePinDeviceEnrollment(deviceId: string | null, onChanged: () => void) {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingSelfApprovalDevice | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    if (!user?.id || !deviceId) {
      setPending(null);
      return;
    }

    const { data, error: queryError } = await supabase
      .from('user_devices')
      .select('device_id,device_name,device_public_key,device_signing_key,approval_challenge_id,approval_status,is_active,revoked_at,platform,binding_status')
      .eq('user_id', user.id)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (queryError) {
      setError(`DEVICE_PENDING_LOOKUP_FAILED:${queryError.message}`);
      return;
    }

    if (
      !data
      || data.approval_status !== 'pending'
      || data.is_active !== false
      || data.revoked_at
      || !data.approval_challenge_id
      || !data.device_public_key
      || !data.device_signing_key
    ) {
      setPending(null);
      return;
    }

    let fingerprintLines: string[] = [];
    try {
      const fingerprint = await computeDeviceApprovalFingerprint({
        deviceId: data.device_id,
        devicePublicKey: data.device_public_key,
        deviceSigningKey: data.device_signing_key,
      });
      fingerprintLines = formatDeviceApprovalFingerprint(fingerprint);
    } catch {
      // Human verification aid only; never a trust authority.
    }

    setPending({
      deviceId: data.device_id,
      challengeId: data.approval_challenge_id,
      deviceName: data.device_name || getCurrentDeviceLabel(),
      platform: data.platform,
      devicePublicKey: data.device_public_key,
      deviceSigningKey: data.device_signing_key,
      fingerprintLines,
    });
    setError(null);
  }, [deviceId, user?.id]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const startEnrollment = useCallback(async () => {
    if (!user?.id || processing) return;
    setProcessing(true);
    setError(null);
    setCurrentDeviceUserScope(user.id);

    let challenge: DeviceEnrollmentChallenge | null = null;
    let stagedDeviceId: string | null = null;

    try {
      // Explicit click is the only path allowed to create a fresh logical device.
      await beginExplicitDeviceEnrollment('user_requested_new_device');

      challenge = await beginServerAssignedDeviceEnrollment({
        deviceName: getCurrentDeviceLabel(),
        // Descriptive/risk metadata only. Server never uses it to resume identity.
        deviceFingerprint: await getDeviceFingerprint(),
        platform: normalizePlatform(getCurrentPlatform()),
        userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 500),
      });

      stagedDeviceId = setCurrentDeviceId(challenge.deviceId);

      const [deviceIdentity, deviceKx] = await Promise.all([
        getOrCreateDeviceIdentity(user.id, stagedDeviceId),
        getOrCreateDeviceKxKey(stagedDeviceId, user.id),
      ]);

      // PRE-PIN invariant: no account key, account fingerprint, SPK/OPK, fanout,
      // inbox, or account sync is touched here. Only the device credential and
      // a possession proof are staged.
      await completeServerAssignedDeviceEnrollmentV2(challenge, deviceIdentity, deviceKx);
      challenge = null;

      window.dispatchEvent(new CustomEvent('forsure:device-approval-pending', {
        detail: { deviceId: stagedDeviceId, source: 'explicit-pre-pin-enrollment-v2' },
      }));
      onChanged();
      await loadPending();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'DEVICE_ENROLLMENT_START_FAILED';
      setError(message);

      if (challenge) {
        await cancelServerAssignedDeviceEnrollment(challenge, message.slice(0, 120)).catch(() => undefined);
      }
      if (stagedDeviceId) {
        await Promise.allSettled([
          deleteDeviceIdentity(user.id, stagedDeviceId),
          deleteDeviceKxKey(stagedDeviceId, user.id),
        ]);
      }
    } finally {
      setProcessing(false);
    }
  }, [loadPending, onChanged, processing, user?.id]);

  const decide = useCallback(async (decision: DeviceApprovalDecision) => {
    if (!user?.id || !pending || processing) return;
    setProcessing(true);
    setError(null);
    try {
      await submitSelfDeviceApprovalDecision({
        userId: user.id,
        target: {
          deviceId: pending.deviceId,
          challengeId: pending.challengeId,
          devicePublicKey: pending.devicePublicKey,
          deviceSigningKey: pending.deviceSigningKey,
        },
        decision,
      });

      const eventName = decision === 'approve'
        ? 'forsure:device-approved'
        : 'forsure:current-device-revoked';
      window.dispatchEvent(new CustomEvent(eventName, {
        detail: { deviceId: pending.deviceId, source: 'explicit-self-approval-v2' },
      }));
      setPending(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'DEVICE_APPROVAL_DECISION_FAILED');
    } finally {
      setProcessing(false);
    }
  }, [onChanged, pending, processing, user?.id]);

  return {
    pending,
    processing,
    error,
    startEnrollment,
    decide,
    reloadPending: loadPending,
  };
}
