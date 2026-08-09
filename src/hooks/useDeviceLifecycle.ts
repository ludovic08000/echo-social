import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  getDeviceIdStatus,
  peekCurrentDeviceId,
  type CurrentDeviceIdStatus,
} from '@/lib/messaging/currentDevice';
import {
  canPromptForPin,
  canRunCryptoRuntime,
  requiresDeviceApprovalUi,
  resolveDeviceLifecycleState,
  type AegisDeviceLifecycleState,
  type DeviceLifecycleRecord,
  type DeviceLifecycleReason,
} from '@/lib/device-manager/deviceLifecycleMachine';
import { readPinUnlocked, subscribePinUnlocked } from '@/lib/device-manager/pinUnlockSignal';

const REFRESH_EVENTS = [
  'forsure:device-approval-pending',
  'forsure:current-device-revoked',
  'forsure:e2ee-device-link-required',
  'forsure:device-approved',
  'forsure:authenticated-device-enroll',
];

const POLL_MS = 15_000;

export interface DeviceLifecycleSnapshot {
  state: AegisDeviceLifecycleState;
  reason: DeviceLifecycleReason;
  deviceId: string | null;
  deviceIdStatus: CurrentDeviceIdStatus;
  record: DeviceLifecycleRecord | null;
  loading: boolean;
  pinUnlocked: boolean;
  canPromptForPin: boolean;
  canRunCryptoRuntime: boolean;
  needsApprovalUi: boolean;
  refresh: () => void;
}

/**
 * Observateur de la machine d'état appareil. Lecture seule : ce hook ne crée
 * jamais de DeviceID et ne déclenche aucune opération cryptographique.
 */
export function useDeviceLifecycle(): DeviceLifecycleSnapshot {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [record, setRecord] = useState<DeviceLifecycleRecord | null | 'unknown'>('unknown');
  const [deviceIdStatus, setDeviceIdStatus] = useState<CurrentDeviceIdStatus>(() => getDeviceIdStatus());
  const [deviceId, setDeviceId] = useState<string | null>(() => peekCurrentDeviceId());
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    const status = getDeviceIdStatus();
    const currentId = peekCurrentDeviceId();
    setDeviceIdStatus(status);
    setDeviceId(currentId);

    if (!userId || !currentId || status !== 'ok') {
      setRecord(currentId && status === 'ok' ? 'unknown' : null);
      return;
    }

    void (async () => {
      const { data, error } = await supabase
        .from('user_devices')
        .select('device_id, approval_status, is_active, revoked_at')
        .eq('user_id', userId)
        .eq('device_id', currentId)
        .maybeSingle();

      if (!mountedRef.current) return;
      if (error) {
        setRecord('unknown');
        return;
      }
      setRecord(
        data
          ? {
              deviceId: data.device_id,
              approvalStatus: (data.approval_status as DeviceLifecycleRecord['approvalStatus']) ?? null,
              isActive: data.is_active ?? null,
              revokedAt: data.revoked_at ?? null,
            }
          : null,
      );
    })();
  }, [userId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!userId) {
      setRecord(null);
      setPinUnlocked(false);
      return;
    }
    setPinUnlocked(readPinUnlocked(userId));
    refresh();

    const unsubscribePin = subscribePinUnlocked(userId, (unlocked) => {
      if (mountedRef.current) setPinUnlocked(unlocked);
    });

    const onEvent = () => refresh();
    REFRESH_EVENTS.forEach((name) => window.addEventListener(name, onEvent));
    const poll = window.setInterval(onEvent, POLL_MS);

    const channel = supabase
      .channel(`device-lifecycle-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_devices', filter: `user_id=eq.${userId}` },
        onEvent,
      )
      .subscribe();

    return () => {
      unsubscribePin();
      REFRESH_EVENTS.forEach((name) => window.removeEventListener(name, onEvent));
      window.clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [userId, refresh]);

  return useMemo(() => {
    const { state, reason } = resolveDeviceLifecycleState({
      authenticated: !!userId,
      deviceRecord: record,
      deviceIdStatus,
      pinUnlocked,
      accountSyncPhase: 'idle',
    });

    return {
      state,
      reason,
      deviceId,
      deviceIdStatus,
      record: record === 'unknown' ? null : record,
      loading: record === 'unknown',
      pinUnlocked,
      canPromptForPin: canPromptForPin(state),
      canRunCryptoRuntime: canRunCryptoRuntime(state),
      needsApprovalUi: requiresDeviceApprovalUi(state),
      refresh,
    };
  }, [userId, record, deviceIdStatus, deviceId, pinUnlocked, refresh]);
}
