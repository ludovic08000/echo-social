import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { deviceApi, type DeviceApiListRecord } from '@/lib/api/deviceApi';
import {
  computeDeviceApprovalFingerprint,
  formatDeviceApprovalFingerprint,
} from '@/lib/crypto/deviceApprovalFingerprint';

export interface PendingApprovalRequest {
  deviceId: string;
  deviceName: string;
  platform: string | null;
  createdAt: string;
  fingerprintLines: string[];
}

const REFRESH_EVENTS = [
  'forsure:device-approval-pending',
  'forsure:device-approved',
  'forsure:authenticated-device-enroll',
];

const POLL_MS = 20_000;

/** Un appareil ne peut décider que s'il est lui-même totalement prêt (jamais d'auto-approbation). */
function isApproverReady(device: DeviceApiListRecord | undefined): boolean {
  return !!device
    && device.approvalStatus === 'approved'
    && device.isActive
    && !device.revokedAt
    && device.bindingStatus === 'bound'
    && device.routingStatus === 'ready'
    && device.lifecycleStatus === 'ready';
}

export function usePendingDeviceApprovalRequests() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [requests, setRequests] = useState<PendingApprovalRequest[]>([]);
  const [canDecide, setCanDecide] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!userId) {
      setRequests([]);
      setCanDecide(false);
      return;
    }
    try {
      const currentDeviceId = deviceApi.getCurrentId(userId);
      const devices = await deviceApi.listDevices(userId);
      const approver = devices.find((device) => device.deviceId === currentDeviceId);
      const ready = !!currentDeviceId && isApproverReady(approver);
      if (!mountedRef.current) return;
      setCanDecide(ready);

      if (!ready) {
        setRequests([]);
        return;
      }

      const pending = devices.filter((device) =>
        device.deviceId !== currentDeviceId
        && device.approvalStatus === 'pending'
        && !device.revokedAt);

      const mapped = await Promise.all(pending.map(async (device) => {
        let fingerprintLines: string[] = [];
        if (device.devicePublicKey && device.deviceSigningKey) {
          const fingerprint = await computeDeviceApprovalFingerprint({
            deviceId: device.deviceId,
            devicePublicKey: device.devicePublicKey,
            deviceSigningKey: device.deviceSigningKey,
          }).catch(() => null);
          if (fingerprint) fingerprintLines = formatDeviceApprovalFingerprint(fingerprint);
        }
        return {
          deviceId: device.deviceId,
          deviceName: device.deviceName || device.platform || 'Appareil inconnu',
          platform: device.platform,
          createdAt: device.createdAt,
          fingerprintLines,
        } satisfies PendingApprovalRequest;
      }));

      if (!mountedRef.current) return;
      setRequests(mapped);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'DEVICE_LIST_FAILED');
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void refresh();

    const onEvent = () => { void refresh(); };
    REFRESH_EVENTS.forEach((name) => window.addEventListener(name, onEvent));
    const poll = window.setInterval(onEvent, POLL_MS);

    const channel = supabase
      .channel(`pending-device-approvals-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_devices', filter: `user_id=eq.${userId}` },
        onEvent,
      )
      .subscribe();

    return () => {
      REFRESH_EVENTS.forEach((name) => window.removeEventListener(name, onEvent));
      window.clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [userId, refresh]);

  const decide = useCallback(async (targetDeviceId: string, decision: 'approve' | 'reject') => {
    if (!userId) return false;
    setDeciding(targetDeviceId);
    setError(null);
    try {
      if (decision === 'approve') await deviceApi.approve(userId, targetDeviceId);
      else await deviceApi.reject(userId, targetDeviceId);
      if (mountedRef.current) {
        setRequests((current) => current.filter((item) => item.deviceId !== targetDeviceId));
      }
      await refresh();
      window.dispatchEvent(new CustomEvent('forsure:device-approved', { detail: { deviceId: targetDeviceId, decision } }));
      return true;
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'DEVICE_DECISION_FAILED');
      return false;
    } finally {
      if (mountedRef.current) setDeciding(null);
    }
  }, [userId, refresh]);

  return { requests, canDecide, deciding, error, decide, refresh };
}
