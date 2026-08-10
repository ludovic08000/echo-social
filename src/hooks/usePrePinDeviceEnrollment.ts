import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { deviceApi, type DeviceApiRecord } from '@/lib/api/deviceApi';
import { submitPrimaryBootstrapDecision } from '@/lib/crypto/deviceApprovalDecision';
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
  const [approvalMode, setApprovalMode] = useState<'bootstrap' | 'trusted_approver_required' | null>(null);

  const reloadPending = useCallback(async () => {
    if (!user?.id) {
      setPending(null);
      setCanBootstrapPrimary(false);
      setApprovalMode(null);
      return;
    }

    const snapshot = await deviceApi.getState(user.id);
    const nextPending = await toPending(snapshot.record);
    setPending(nextPending);

    if (!snapshot.record || !nextPending) {
      setCanBootstrapPrimary(false);
      setApprovalMode(null);
      setError(null);
      return;
    }

    const { data, error: modeError } = await supabase.rpc('get_device_enrollment_approval_mode' as never, {
      p_device_id: snapshot.record.deviceId,
    } as never);
    const mode = data as {
      ok?: boolean;
      code?: string;
      bootstrap_primary?: boolean;
      approval_mode?: 'bootstrap' | 'trusted_approver_required';
    } | null;

    if (modeError || mode?.ok !== true) {
      throw new Error(`DEVICE_APPROVAL_MODE_FAILED:${mode?.code ?? modeError?.message ?? 'UNKNOWN'}`);
    }

    setCanBootstrapPrimary(mode.bootstrap_primary === true);
    setApprovalMode(mode.approval_mode ?? null);
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
      await reloadPending();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'DEVICE_ENROLLMENT_START_FAILED');
    } finally {
      setProcessing(false);
    }
  }, [onChanged, processing, reloadPending, user?.id]);

  const decide = useCallback(async (decision: 'approve' | 'reject') => {
    if (!user?.id || !pending || processing) return;
    setProcessing(true);
    setError(null);
    try {
      if (!canBootstrapPrimary || approvalMode !== 'bootstrap') {
        throw new Error('DEVICE_WAITING_FOR_TRUSTED_APPROVER');
      }

      await submitPrimaryBootstrapDecision({
        userId: user.id,
        target: {
          deviceId: pending.deviceId,
          challengeId: pending.challengeId,
          devicePublicKey: pending.devicePublicKey,
          deviceSigningKey: pending.deviceSigningKey,
        },
        decision,
      });

      window.dispatchEvent(new CustomEvent(
        decision === 'approve' ? 'forsure:device-approved' : 'forsure:current-device-revoked',
        { detail: { deviceId: pending.deviceId, source: 'server-authoritative-bootstrap' } },
      ));
      setPending(null);
      setCanBootstrapPrimary(false);
      setApprovalMode(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'DEVICE_APPROVAL_DECISION_FAILED');
    } finally {
      setProcessing(false);
    }
  }, [approvalMode, canBootstrapPrimary, onChanged, pending, processing, user?.id]);

  return {
    pending,
    processing,
    error,
    canBootstrapPrimary,
    approvalMode,
    startEnrollment,
    decide,
    reloadPending,
  };
}
