import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { deviceSecurity, type DeviceSecurityRecord } from '@/lib/device-manager/deviceSecurity';
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

async function toPending(record: DeviceSecurityRecord | null): Promise<PendingDeviceApproval | null> {
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

export function usePrePinDeviceEnrollment(_deviceId: string | null, onChanged: () => void) {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingDeviceApproval | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadPending = useCallback(async () => {
    if (!user?.id) {
      setPending(null);
      return;
    }
    const snapshot = await deviceSecurity.getState(user.id);
    setPending(await toPending(snapshot.record));
    setError(null);
  }, [user?.id]);

  useEffect(() => {
    void reloadPending().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'DEVICE_STATE_LOOKUP_FAILED');
    });
  }, [reloadPending]);

  const startEnrollment = useCallback(async () => {
    if (!user?.id || processing) return;
    setProcessing(true);
    setError(null);
    try {
      const record = await deviceSecurity.enroll(user.id);
      setPending(await toPending(record));
      window.dispatchEvent(new CustomEvent('forsure:device-approval-pending', {
        detail: { deviceId: record.deviceId, source: 'deviceSecurity.enroll' },
      }));
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'DEVICE_ENROLLMENT_START_FAILED');
    } finally {
      setProcessing(false);
    }
  }, [onChanged, processing, user?.id]);

  const decide = useCallback(async (decision: 'approve' | 'reject') => {
    if (!user?.id || !pending || processing) return;
    setProcessing(true);
    setError(null);
    try {
      const record = decision === 'approve'
        ? await deviceSecurity.approve(user.id)
        : await deviceSecurity.reject(user.id);

      window.dispatchEvent(new CustomEvent(
        decision === 'approve' ? 'forsure:device-approved' : 'forsure:current-device-revoked',
        { detail: { deviceId: record.deviceId, source: 'deviceSecurity.approval' } },
      ));
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
    reloadPending,
  };
}
