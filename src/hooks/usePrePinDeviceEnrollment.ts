import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
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

export function usePrePinDeviceEnrollment(_deviceId: string | null, onChanged: () => void) {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingDeviceApproval | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canBootstrapPrimary, setCanBootstrapPrimary] = useState(false);

  const reloadPending = useCallback(async () => {
    if (!user?.id) {
      setPending(null);
      return;
    }
    const snapshot = await deviceApi.getState(user.id);
    setPending(await toPending(snapshot.record));
    const devices = await deviceApi.listDevices(user.id);
    setCanBootstrapPrimary(Boolean(snapshot.record) && devices.every((device) => device.deviceId === snapshot.record?.deviceId));
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
      const record = await deviceApi.enroll(user.id);
      setPending(await toPending(record));
      window.dispatchEvent(new CustomEvent('forsure:device-approval-pending', {
        detail: { deviceId: record.deviceId, source: 'deviceApi.enroll' },
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
    startEnrollment,
    decide,
    reloadPending,
  };
}
