import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { deviceApi, type DeviceApiRecord } from '@/lib/api/deviceApi';

export interface PendingDeviceApproval {
  deviceId: string;
  challengeId: string;
  deviceName: string;
  platform: string | null;
}

function toPending(record: DeviceApiRecord | null): PendingDeviceApproval | null {
  if (
    !record
    || record.approvalStatus !== 'pending'
    || !record.approvalChallengeId
    || !record.devicePublicKey
    || !record.deviceSigningKey
  ) {
    return null;
  }
  return {
    deviceId: record.deviceId,
    challengeId: record.approvalChallengeId,
    deviceName: record.deviceName ?? 'Nouvel appareil',
    platform: record.platform,
  };
}

/**
 * Invariant cryptographique modifié : l'écran « en attente d'approbation » est
 * supprimé. Un appareil enrôlé (ou déjà pending) demande immédiatement son
 * approbation au serveur, qui seul valide propriété + signatures. Le client
 * n'assume jamais un statut approuvé et échoue fermé en cas d'erreur serveur.
 */
export function usePrePinDeviceEnrollment(deviceId: string | null, onChanged: () => void) {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingDeviceApproval | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enrollmentInFlightRef = useRef(false);
  const approvalInFlightRef = useRef<string | null>(null);

  const reloadPending = useCallback(async () => {
    if (!user?.id) {
      setPending(null);
      return;
    }
    const snapshot = await deviceApi.getState(user.id);
    setPending(toPending(snapshot.record));
  }, [user?.id]);

  useEffect(() => {
    void reloadPending().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'DEVICE_STATE_LOOKUP_FAILED');
    });
  }, [reloadPending]);

  const autoApprove = useCallback(async () => {
    if (!user?.id || !pending) return;
    if (approvalInFlightRef.current === pending.deviceId) return;
    approvalInFlightRef.current = pending.deviceId;
    setProcessing(true);
    setError(null);
    try {
      const record = await deviceApi.autoApprove(user.id);
      window.dispatchEvent(new CustomEvent('forsure:device-approved', {
        detail: { deviceId: record.deviceId, source: 'deviceApi.autoApprove' },
      }));
      setPending(null);
      onChanged();
    } catch (cause) {
      approvalInFlightRef.current = null;
      setError(cause instanceof Error ? cause.message : 'DEVICE_AUTO_APPROVAL_FAILED');
    } finally {
      setProcessing(false);
    }
  }, [onChanged, pending, user?.id]);

  // Reprise automatique d'un appareil resté bloqué en `pending`.
  useEffect(() => {
    if (!pending || !user?.id) return;
    void autoApprove();
  }, [autoApprove, pending, user?.id]);

  const startEnrollment = useCallback(async () => {
    if (!user?.id || processing || enrollmentInFlightRef.current || deviceId || pending) return;
    enrollmentInFlightRef.current = true;
    setProcessing(true);
    setError(null);
    try {
      const record = await deviceApi.enroll(user.id);
      setPending(toPending(record));
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'DEVICE_ENROLLMENT_START_FAILED');
    } finally {
      enrollmentInFlightRef.current = false;
      setProcessing(false);
    }
  }, [deviceId, onChanged, pending, processing, user?.id]);

  return {
    pending,
    processing,
    error,
    canStartEnrollment: !deviceId && !pending && !processing,
    startEnrollment,
    autoApprove,
    reloadPending,
  };
}
