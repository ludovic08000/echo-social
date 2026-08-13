import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { deviceApi, type DeviceApiRecord } from '@/lib/api/deviceApi';
import {
  computeDeviceApprovalFingerprint,
  formatDeviceApprovalFingerprint,
} from '@/lib/crypto/deviceApprovalFingerprint';

export interface PendingDeviceApproval {
  deviceId: string;
  challengeId: string;
  deviceName: string;
  platform: string | null;
  devicePublicKey: string;
  deviceSigningKey: string;
  fingerprintLines: string[];
}

async function toPending(record: DeviceApiRecord | null): Promise<PendingDeviceApproval | null> {
  if (
    !record
    || record.approvalStatus !== 'pending'
    || !record.approvalChallengeId
    || !record.devicePublicKey
    || !record.deviceSigningKey
  ) {
    return null;
  }

  const fingerprint = await computeDeviceApprovalFingerprint({
    deviceId: record.deviceId,
    devicePublicKey: record.devicePublicKey,
    deviceSigningKey: record.deviceSigningKey,
  }).catch(() => null);

  return {
    deviceId: record.deviceId,
    challengeId: record.approvalChallengeId,
    deviceName: record.deviceName ?? 'Nouvel appareil',
    platform: record.platform,
    devicePublicKey: record.devicePublicKey,
    deviceSigningKey: record.deviceSigningKey,
    fingerprintLines: fingerprint ? formatDeviceApprovalFingerprint(fingerprint) : [],
  };
}

export function usePrePinDeviceEnrollment(deviceId: string | null, onChanged: () => void) {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingDeviceApproval | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canBootstrapPrimary, setCanBootstrapPrimary] = useState(false);
  const enrollmentInFlightRef = useRef(false);

  const reloadPending = useCallback(async () => {
    if (!user?.id) {
      setPending(null);
      setCanBootstrapPrimary(false);
      return;
    }

    const snapshot = await deviceApi.getState(user.id);
    const pendingDevice = await toPending(snapshot.record);
    setPending(pendingDevice);

    if (!snapshot.record || !pendingDevice) {
      setCanBootstrapPrimary(false);
      setError(null);
      return;
    }

    const { data, error: modeError } = await supabase.rpc(
      'get_device_enrollment_approval_mode' as never,
      { p_device_id: snapshot.record.deviceId } as never,
    );

    if (modeError) {
      throw new Error(`DEVICE_APPROVAL_MODE_LOOKUP_FAILED:${modeError.message}`);
    }

    const mode = data as {
      ok?: boolean;
      code?: string;
      bootstrap_primary?: boolean;
      approval_mode?: string;
    } | null;

    if (!mode || mode.ok !== true) {
      throw new Error(mode?.code ?? 'DEVICE_APPROVAL_MODE_LOOKUP_REJECTED');
    }

    setCanBootstrapPrimary(mode.bootstrap_primary === true);
    setError(null);
  }, [user?.id]);

  useEffect(() => {
    void reloadPending().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'DEVICE_STATE_LOOKUP_FAILED');
    });
  }, [reloadPending]);

  const startEnrollment = useCallback(async () => {
    if (!user?.id || processing || enrollmentInFlightRef.current || deviceId || pending) return;
    enrollmentInFlightRef.current = true;
    setProcessing(true);
    setError(null);
    try {
      const record = await deviceApi.enroll(user.id);
      setPending(await toPending(record));
      window.dispatchEvent(new CustomEvent('forsure:device-approval-pending', {
        detail: { deviceId: record.deviceId, source: 'deviceApi.enroll' },
      }));
      onChanged();
      await reloadPending();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'DEVICE_ENROLLMENT_START_FAILED');
    } finally {
      enrollmentInFlightRef.current = false;
      setProcessing(false);
    }
  }, [deviceId, onChanged, pending, processing, reloadPending, user?.id]);

  const decide = useCallback(async (decision: 'approve' | 'reject') => {
    if (!user?.id || !pending || processing) return;
    setProcessing(true);
    setError(null);
    try {
      if (!canBootstrapPrimary || decision !== 'approve') throw new Error('DEVICE_WAITING_FOR_TRUSTED_APPROVER');
      const record = await deviceApi.bootstrapPrimary(user.id);

      window.dispatchEvent(new CustomEvent(
        decision === 'approve' ? 'forsure:device-approved' : 'forsure:current-device-revoked',
        { detail: { deviceId: record.deviceId, source: 'deviceApi.approval' } },
      ));
      setPending(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'DEVICE_APPROVAL_DECISION_FAILED');
    } finally {
      setProcessing(false);
    }
  }, [canBootstrapPrimary, onChanged, pending, processing, user?.id]);

  return {
    pending,
    processing,
    error,
    canBootstrapPrimary,
    canStartEnrollment: !deviceId && !pending && !processing,
    startEnrollment,
    decide,
    reloadPending,
  };
}
