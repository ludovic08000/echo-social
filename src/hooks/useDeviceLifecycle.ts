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
import { syncIosDeviceAdapter } from '@/platforms/ios/iosLifecycleAdapter';
import { syncAndroidDeviceAdapter } from '@/platforms/android/androidLifecycleAdapter';

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

function logDeviceLifecycle(stage: string, details: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info') {
  const payload = { ts: new Date().toISOString(), stage, ...details };
  if (level === 'error') console.error('[E2EE][DEVICE_LIFECYCLE]', payload);
  else if (level === 'warn') console.warn('[E2EE][DEVICE_LIFECYCLE]', payload);
  else console.info('[E2EE][DEVICE_LIFECYCLE]', payload);
}

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
  const bindingInFlightRef = useRef<string | null>(null);
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

    setCurrentDeviceUserScope(userId);

    void (async () => {
      try {
        await hydrateDeviceId();
      } catch (error) {
        logDeviceLifecycle('hydrate-device-id-failed', {
          message: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }

      if (!mountedRef.current || generation !== refreshGenerationRef.current) return;

      const status = getDeviceIdStatus();
      const currentId = peekCurrentDeviceId();
      setDeviceIdStatus(status);
      setDeviceId(currentId);

      logDeviceLifecycle('device-id-state', {
        deviceId: currentId,
        deviceIdStatus: status,
      });

      if (!currentId || status !== 'ok') {
        setRecord(null);
        return;
      }

      try {
        const snapshot = await deviceApi.getState(userId);
        if (!mountedRef.current || generation !== refreshGenerationRef.current) return;
        const row = snapshot.record;
        logDeviceLifecycle('server-device-state', {
          deviceId: row?.deviceId ?? currentId,
          state: snapshot.state,
          approvalStatus: row?.approvalStatus ?? null,
          bindingStatus: row?.bindingStatus ?? null,
          routingStatus: row?.routingStatus ?? null,
          lifecycleStatus: row?.lifecycleStatus ?? null,
          isActive: row?.isActive ?? null,
          revoked: Boolean(row?.revokedAt),
        });
        setRecord(row ? {
          deviceId: row.deviceId,
          approvalStatus: row.approvalStatus,
          bindingStatus: row.bindingStatus,
          routingStatus: row.routingStatus,
          isActive: row.isActive,
          revokedAt: row.revokedAt,
        } : null);
        // Adaptateur iOS isolé : no-op complet hors runtime iOS.
        if (row) void syncIosDeviceAdapter(userId, row.deviceId);
        if (row) void syncAndroidDeviceAdapter(userId, row.deviceId);

      } catch (error) {
        logDeviceLifecycle('server-device-state-failed', {
          deviceId: currentId,
          message: error instanceof Error ? error.message : String(error),
        }, 'error');
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
      bindingInFlightRef.current = null;
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

  // Canonical transition: approved -> bound. The previous lifecycle waited for
  // bindingStatus='bound' but never actually triggered deviceApi.bind(), which
  // could leave a freshly bootstrapped primary device stuck forever in
  // "Finalisation de l'appareil..." with DEVICE_SYNC_REQUIRED.
  useEffect(() => {
    if (!userId || !deviceId || record === 'unknown' || !record) return;
    if (deviceIdStatus !== 'ok') return;
    if (record.deviceId !== deviceId) return;
    if (record.approvalStatus !== 'approved') return;
    if (!record.isActive || record.revokedAt) return;
    if (record.bindingStatus === 'bound') return;
    if (record.bindingStatus !== 'pending') return;
    if (bindingInFlightRef.current === deviceId) {
      logDeviceLifecycle('bind-account-skip-inflight', { deviceId });
      return;
    }

    bindingInFlightRef.current = deviceId;
    const startedAt = Date.now();
    logDeviceLifecycle('bind-account-start', {
      deviceId,
      approvalStatus: record.approvalStatus,
      bindingStatus: record.bindingStatus,
      routingStatus: record.routingStatus,
    });

    void deviceApi.bind(userId)
      .then((updated) => {
        logDeviceLifecycle('bind-account-success', {
          deviceId,
          elapsedMs: Date.now() - startedAt,
          bindingStatus: updated.bindingStatus,
          routingStatus: updated.routingStatus,
          lifecycleStatus: updated.lifecycleStatus,
        });
        window.dispatchEvent(new CustomEvent('forsure:device-account-bound', {
          detail: { userId, deviceId },
        }));
        if (mountedRef.current) refresh();
      })
      .catch((error) => {
        logDeviceLifecycle('bind-account-failed', {
          deviceId,
          elapsedMs: Date.now() - startedAt,
          name: error instanceof Error ? error.name : undefined,
          message: error instanceof Error ? error.message : String(error),
        }, 'error');
      })
      .finally(() => {
        logDeviceLifecycle('bind-account-finished', {
          deviceId,
          elapsedMs: Date.now() - startedAt,
        });
        if (bindingInFlightRef.current === deviceId) bindingInFlightRef.current = null;
      });
  }, [userId, deviceId, deviceIdStatus, record, refresh]);

  useEffect(() => {
    if (!userId || !deviceId || record === 'unknown' || !record) return;
    if (deviceIdStatus !== 'ok') return;
    if (record.deviceId !== deviceId) return;
    if (record.approvalStatus !== 'approved' || record.bindingStatus !== 'bound') return;
    if (!record.isActive || record.revokedAt) return;
    if (record.routingStatus === 'ready') {
      logDeviceLifecycle('prepare-keys-skip-ready', { deviceId });
      return;
    }
    if (keySetupInFlightRef.current === deviceId) {
      logDeviceLifecycle('prepare-keys-skip-inflight', { deviceId });
      return;
    }

    keySetupInFlightRef.current = deviceId;
    const startedAt = Date.now();
    logDeviceLifecycle('prepare-keys-start', {
      deviceId,
      approvalStatus: record.approvalStatus,
      bindingStatus: record.bindingStatus,
      routingStatus: record.routingStatus,
    });

    void deviceApi.prepareKeys(userId)
      .then((updated) => {
        logDeviceLifecycle('prepare-keys-success', {
          deviceId,
          elapsedMs: Date.now() - startedAt,
          routingStatus: updated.routingStatus,
          lifecycleStatus: updated.lifecycleStatus,
        });
        if (mountedRef.current) refresh();
      })
      .catch((error) => {
        logDeviceLifecycle('prepare-keys-failed', {
          deviceId,
          elapsedMs: Date.now() - startedAt,
          name: error instanceof Error ? error.name : undefined,
          message: error instanceof Error ? error.message : String(error),
        }, 'error');
      })
      .finally(() => {
        logDeviceLifecycle('prepare-keys-finished', {
          deviceId,
          elapsedMs: Date.now() - startedAt,
        });
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
