import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  getDeviceIdStatus,
  hydrateDeviceId,
  peekCurrentDeviceId,
  setCurrentDeviceUserScope,
  type CurrentDeviceIdStatus,
} from '@/lib/messaging/currentDevice';
import { deviceApi } from '@/lib/api/deviceApi';
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
  const [deviceIdStatus, setDeviceIdStatus] = useState<CurrentDeviceIdStatus>('uninitialized');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const mountedRef = useRef(true);
  const refreshGenerationRef = useRef(0);
  const keySetupInFlightRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    const generation = ++refreshGenerationRef.current;

    if (!userId) {
      setCurrentDeviceUserScope(null);
      setDeviceIdStatus('uninitialized');
      setDeviceId(null);
      setRecord(null);
      return;
    }

    // DeviceID persistence is account-scoped. Always establish the user scope
    // and hydrate the durable ID before making any lifecycle decision. During
    // background refreshes we intentionally keep the last known device record
    // instead of switching to `unknown`; otherwise the approval gate replaces
    // the entire messaging UI with a loading screen every poll/event refresh.
    setCurrentDeviceUserScope(userId);

    void (async () => {
      try {
        await hydrateDeviceId();
      } catch {
        // A genuinely missing/mismatched durable ID is handled below through
        // getDeviceIdStatus(). Never allocate a replacement ID here.
      }

      if (!mountedRef.current || generation !== refreshGenerationRef.current) return;

      const status = getDeviceIdStatus();
      const currentId = peekCurrentDeviceId();
      setDeviceIdStatus(status);
      setDeviceId(currentId);

      if (!currentId || status !== 'ok') {
        setRecord(null);
        return;
      }

      try {
        const snapshot = await deviceApi.getState(userId);
        if (!mountedRef.current || generation !== refreshGenerationRef.current) return;
        const row = snapshot.record;
        setRecord(row ? {
          deviceId: row.deviceId,
          approvalStatus: row.approvalStatus,
          bindingStatus: row.bindingStatus,
          routingStatus: row.routingStatus,
          isActive: row.isActive,
          revokedAt: row.revokedAt,
        } : null);
      } catch {
        // Keep the last known good record on a transient refresh failure. A
        // subsequent poll/realtime event will retry. This avoids destructive UI
        // flicker while preserving fail-closed behaviour on initial load.
      }
    })();
  }, [userId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!userId) {
      setCurrentDeviceUserScope(null);
      setRecord(null);
      setPinUnlocked(false);
      setDeviceId(null);
      setDeviceIdStatus('uninitialized');
      keySetupInFlightRef.current = null;
      return;
    }

    setCurrentDeviceUserScope(userId);
    setRecord('unknown');
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

  // After approval + account binding the device is not routable until its
  // Signed PreKey / OPKs have been published and synchronization has completed.
  // This used to be left to a UI transition, so a device could remain forever
  // in SIGNED_PREKEY_VALIDATION_PENDING and therefore could not approve a
  // secondary device. Complete that cryptographic setup automatically for the
  // current device, while keeping the operation single-flight per device.
  useEffect(() => {
    if (!userId || !deviceId || record === 'unknown' || !record) return;
    if (deviceIdStatus !== 'ok') return;
    if (record.deviceId !== deviceId) return;
    if (record.approvalStatus !== 'approved' || record.bindingStatus !== 'bound') return;
    if (!record.isActive || record.revokedAt) return;
    if (record.routingStatus === 'ready') return;
    if (keySetupInFlightRef.current === deviceId) return;

    keySetupInFlightRef.current = deviceId;
    void deviceApi.prepareKeys(userId)
      .then(() => {
        if (mountedRef.current) refresh();
      })
      .catch((error) => {
        console.error('[DeviceLifecycle] automatic device key setup failed', error);
      })
      .finally(() => {
        if (keySetupInFlightRef.current === deviceId) keySetupInFlightRef.current = null;
      });
  }, [userId, deviceId, deviceIdStatus, record, refresh]);

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
