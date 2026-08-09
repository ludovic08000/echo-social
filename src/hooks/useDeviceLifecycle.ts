import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  getDeviceIdStatus,
  peekCurrentDeviceId,
  type CurrentDeviceIdStatus,
} from '@/lib/messaging/currentDevice';
import { deviceSecurity } from '@/lib/device-manager/deviceSecurity';
import {
  canPromptForPin,
  canRunCryptoRuntime,
  canRunDeviceKeySetup,
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
  'forsure:device-account-bound',
  'forsure:aegis-route-ready',
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
  canRunDeviceKeySetup: boolean;
  canRunCryptoRuntime: boolean;
  needsApprovalUi: boolean;
  refresh: () => void;
}

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
      setRecord(null);
      return;
    }

    setRecord('unknown');
    void deviceSecurity.getState(userId).then((snapshot) => {
      if (!mountedRef.current) return;
      const row = snapshot.record;
      setRecord(row ? {
        deviceId: row.deviceId,
        approvalStatus: row.approvalStatus,
        bindingStatus: row.bindingStatus,
        routingStatus: row.routingStatus,
        isActive: row.isActive,
        revokedAt: row.revokedAt,
      } : null);
    }).catch(() => {
      if (mountedRef.current) setRecord('unknown');
    });
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
      canRunDeviceKeySetup: canRunDeviceKeySetup(state),
      canRunCryptoRuntime: canRunCryptoRuntime(state),
      needsApprovalUi: requiresDeviceApprovalUi(state),
      refresh,
    };
  }, [userId, record, deviceIdStatus, deviceId, pinUnlocked, refresh]);
}
