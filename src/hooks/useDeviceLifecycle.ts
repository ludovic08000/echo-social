/**
 * Vue React de l'autorité unique du cycle de vie appareil.
 *
 * Invariant cryptographique : ce hook n'exécute plus aucune transition. Il
 * s'abonne au contrôleur unique par compte (`deviceLifecycleController`), de
 * sorte que dix montages simultanés (App, gates, réglages, StrictMode) ne
 * produisent qu'un seul enrôlement, une seule approbation, un seul binding et
 * une seule préparation de clés.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  getDeviceIdStatus,
  hydrateDeviceId,
  peekCurrentDeviceId,
  setCurrentDeviceUserScope,
} from '@/lib/messaging/currentDevice';
import { deviceApi } from '@/lib/api/deviceApi';
import { cryptoApi } from '@/lib/api/cryptoApi';
import { synchronizeAccountKeysBeforeRuntime } from '@/lib/crypto/accountKeySync';
import { beginAccountSynchronization, type AccountSyncPhase } from '@/lib/messaging/accountSyncBarrier';
import {
  configureDeviceLifecycleDeps,
  getDeviceLifecycleController,
  resetDeviceLifecycleControllers,
  type DeviceLifecycleSnapshot as ControllerSnapshot,
  type DeviceLifecycleStage,
} from '@/lib/device-manager/deviceLifecycleController';
import type {
  AegisDeviceLifecycleState,
  DeviceIdStatus,
  DeviceLifecycleReason,
  DeviceLifecycleRecord,
} from '@/lib/device-manager/deviceLifecycleMachine';
import { readPinUnlocked, subscribePinUnlocked } from '@/lib/device-manager/pinUnlockSignal';
import { isWindowsWeb } from '@/lib/crypto/windowsHelloDeviceRecovery';
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
/**
 * Invariant restauré : le PIN fait partie de l'ordre canonique obligatoire
 * (approbation serveur -> PIN -> binding -> clés -> sync -> messagerie).
 */
const PIN_PROTECTION_ENABLED = true;

function logDeviceLifecycle(stage: string, details: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info') {
  const payload = { ts: new Date().toISOString(), stage, ...details };
  if (level === 'error') console.error('[E2EE][DEVICE_LIFECYCLE]', payload);
  else if (level === 'warn') console.warn('[E2EE][DEVICE_LIFECYCLE]', payload);
  else console.info('[E2EE][DEVICE_LIFECYCLE]', payload);
}

configureDeviceLifecycleDeps((userId) => ({
  api: {
    getState: (id) => deviceApi.getState(id),
    enroll: (id) => deviceApi.enroll(id),
    autoApprove: (id) => deviceApi.autoApprove(id),
    bind: (id) => deviceApi.bind(id),
    prepareKeys: (id) => deviceApi.prepareKeys(id),
    // Preuve réelle de synchronisation de compte : la barrière partagée est la
    // même que celle attendue par le runtime de messagerie.
    // Vraie synchronisation : contrôle/restauration des clés de compte, puis
    // seulement mise en route du runtime crypto. Jamais un ready simulé.
    syncAccount: (id) => beginAccountSynchronization(id, async () => {
      await synchronizeAccountKeysBeforeRuntime(id);
      // Diagnostic uniquement : mesure du démarrage du runtime crypto.
      const ensureElapsed = startFinalizationTimer();
      traceCurrentDeviceFinalization({ step: 'crypto_api.ensure_ready', outcome: 'start', userId: id });
      try {
        await cryptoApi.ensureReady(id);
      } catch (error) {
        traceCurrentDeviceFinalization({
          step: 'crypto_api.ensure_ready',
          outcome: 'failure',
          elapsedMs: ensureElapsed(),
          userId: id,
          errorCode: error,
        });
        throw error;
      }
      traceCurrentDeviceFinalization({
        step: 'crypto_api.ensure_ready',
        outcome: 'success',
        elapsedMs: ensureElapsed(),
        userId: id,
      });
    }),
    finalizeSynchronization: (id) => deviceApi.finalizeSynchronization(id),
  },
  hydrateDeviceId: () => hydrateDeviceId(),
  getDeviceIdStatus: () => getDeviceIdStatus() as DeviceIdStatus,
  peekDeviceId: () => peekCurrentDeviceId(),
  setUserScope: (id) => setCurrentDeviceUserScope(id),
  isWindowsWeb: () => isWindowsWeb(),
  readPinUnlocked: (id) => readPinUnlocked(id),
  subscribePinUnlocked: (id, listener) => subscribePinUnlocked(id, listener),
  onDeviceRecordChanged: (id, listener) => {
    const onEvent = () => listener();
    REFRESH_EVENTS.forEach((name) => window.addEventListener(name, onEvent));
    const poll = window.setInterval(onEvent, POLL_MS);
    const channel = supabase
      .channel(`device-lifecycle-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_devices', filter: `user_id=eq.${id}` },
        onEvent,
      )
      .subscribe();
    return () => {
      REFRESH_EVENTS.forEach((name) => window.removeEventListener(name, onEvent));
      window.clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  },
  pinRequired: PIN_PROTECTION_ENABLED,
  stepTimeoutMs: 90_000,
  log: (stage, details, level) => logDeviceLifecycle(stage, { userId, ...details }, level),
}));

const IDLE_SNAPSHOT: ControllerSnapshot = {
  state: 'AUTHENTICATED',
  reason: 'not_authenticated',
  deviceId: null,
  deviceIdStatus: 'uninitialized',
  record: null,
  loading: false,
  stage: 'idle',
  error: null,
  pinUnlocked: false,
  accountSyncPhase: 'idle',
  canPromptForPin: false,
  canRunDeviceKeySetup: false,
  canRunCryptoRuntime: false,
  needsApprovalUi: false,
  canStartEnrollment: false,
};

export interface DeviceLifecycleSnapshot {
  state: AegisDeviceLifecycleState;
  reason: DeviceLifecycleReason;
  deviceId: string | null;
  deviceIdStatus: DeviceIdStatus;
  record: DeviceLifecycleRecord | null;
  loading: boolean;
  stage: DeviceLifecycleStage;
  pinUnlocked: boolean;
  accountSyncPhase: AccountSyncPhase;
  canPromptForPin: boolean;
  canRunDeviceKeySetup: boolean;
  canRunCryptoRuntime: boolean;
  needsApprovalUi: boolean;
  canStartEnrollment: boolean;
  /** Erreur serveur réelle : jamais masquée par un spinner permanent. */
  error: string | null;
  /** Alias historique conservé pour les écrans existants. */
  transitionError: string | null;
  refresh: () => void;
  retry: () => void;
  startEnrollment: () => void;
}

export function useDeviceLifecycle(): DeviceLifecycleSnapshot {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [snapshot, setSnapshot] = useState<ControllerSnapshot>(IDLE_SNAPSHOT);
  const controllerRef = useRef<ReturnType<typeof getDeviceLifecycleController> | null>(null);

  useEffect(() => {
    if (!userId) {
      controllerRef.current = null;
      resetDeviceLifecycleControllers();
      setCurrentDeviceUserScope(null);
      setSnapshot(IDLE_SNAPSHOT);
      return;
    }
    const controller = getDeviceLifecycleController(userId);
    controllerRef.current = controller;
    setSnapshot(controller.getSnapshot());
    return controller.subscribe(setSnapshot);
  }, [userId]);

  // Adaptateurs plateforme : strictement no-op hors iOS/Android.
  useEffect(() => {
    if (!userId || !snapshot.record) return;
    void syncIosDeviceAdapter(userId, snapshot.record.deviceId);
    void syncAndroidDeviceAdapter(userId, snapshot.record.deviceId);
  }, [userId, snapshot.record]);

  const refresh = useCallback(() => { void controllerRef.current?.refresh(); }, []);
  const retry = useCallback(() => { void controllerRef.current?.retry(); }, []);
  const startEnrollment = useCallback(() => { void controllerRef.current?.startEnrollment(); }, []);

  return useMemo(() => ({
    ...snapshot,
    transitionError: snapshot.error,
    refresh,
    retry,
    startEnrollment,
  }), [snapshot, refresh, retry, startEnrollment]);
}
