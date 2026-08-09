import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import { ensureApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { flushCryptoErrors, logCryptoError } from '@/lib/crypto/errorLogger';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import { getCurrentPlatform, peekCurrentDeviceId } from '@/lib/messaging/currentDevice';
import {
  hydrateDeviceId,
  recoverStableDeviceLifecycle,
  requireAuthenticatedDeviceSession,
  resyncE2EE,
  runDeviceOperation,
} from '@/lib/device-manager';

interface PinValidatedMessagingProps {
  children: ReactNode;
}

type DeviceRouteInspection = {
  exists: boolean;
  ready: boolean;
  hasAuthorization: boolean;
  hasSignedPrekey: boolean;
  status: 'missing' | 'incomplete' | 'ready';
};

function wakeMessageDecryptors(deviceId: string | null, reason: string): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail: { reason, deviceId } }));
    window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', { detail: { reason, deviceId } }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { status: 'pin_unlocked', reason, deviceId },
    }));
  } catch {
    // Best-effort browser notification.
  }
}

function recordEnrollment(
  errorCode: string,
  status: string,
  stage: string,
  severity: 'info' | 'warning' | 'error' = 'info',
  failureCode?: string,
): void {
  logCryptoError({
    severity,
    context: 'restore',
    errorCode,
    errorMessage: errorCode,
    metadata: {
      stage,
      status,
      platform: getCurrentPlatform(),
      ...(failureCode ? { failure_code: failureCode } : {}),
    },
  });
}

function classifyEnrollmentFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/PIN_UNLOCK|PIN.*REQUIRED/i.test(message)) return 'pin_required';
  if (/SESSION/i.test(message)) return 'auth_session';
  if (/DEVICE_ROUTE_NOT_READY/i.test(message)) return 'route_not_ready';
  if (/SPK|PREKEY/i.test(message)) return 'prekey';
  if (/REGISTER|DEVICE_AUTH|IDENTITY|BIND/i.test(message)) return 'device_identity';
  if (/FETCH|NETWORK|TIMEOUT|429|5\d\d/i.test(message)) return 'network';
  return 'unknown';
}

async function inspectCurrentDeviceRoute(userId: string, deviceId: string): Promise<DeviceRouteInspection> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id,is_active,revoked_at,stale_at,approval_status,binding_status,account_bound_at,routing_status,device_authorization_signature')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) throw new Error('DEVICE_ROUTE_LOOKUP_FAILED');
  if (!data) return { exists: false, ready: false, hasAuthorization: false, hasSignedPrekey: false, status: 'missing' };

  const hasAuthorization = data.binding_status === 'bound'
    && Boolean(data.account_bound_at)
    && typeof data.device_authorization_signature === 'string'
    && data.device_authorization_signature.trim().length > 0;
  const hasSignedPrekey = hasAuthorization
    ? Boolean(await peekDeviceSignedPrekey(userId, deviceId).catch(() => null))
    : false;
  const ready = data.is_active === true
    && !data.revoked_at
    && !data.stale_at
    && data.approval_status === 'approved'
    && data.binding_status === 'bound'
    && data.routing_status === 'ready'
    && hasAuthorization
    && hasSignedPrekey;

  return { exists: true, ready, hasAuthorization, hasSignedPrekey, status: ready ? 'ready' : 'incomplete' };
}

async function markCurrentRouteReady(deviceId: string): Promise<void> {
  const { data, error } = await supabase.rpc('mark_current_device_route_ready' as never, { p_device_id: deviceId } as never);
  const result = data as { ok?: boolean; code?: string } | null;
  if (error || result?.ok !== true) throw new Error(`DEVICE_ROUTE_NOT_READY:${result?.code ?? 'RPC_FAILED'}`);
}

export function PinValidatedMessaging({ children }: PinValidatedMessagingProps) {
  const { user } = useAuth();
  const lifecycle = useDeviceLifecycle();
  const deviceId = lifecycle.deviceId;
  const bindingReady = lifecycle.record?.bindingStatus === 'bound'
    && lifecycle.record?.approvalStatus === 'approved'
    && lifecycle.record?.isActive === true
    && !lifecycle.record?.revokedAt;

  useEffect(() => {
    if (!user?.id || !deviceId || !bindingReady) return;

    let cancelled = false;
    const userId = user.id;
    const wake = (reason: string) => {
      if (!cancelled) wakeMessageDecryptors(peekCurrentDeviceId(), reason);
    };

    wake('pin_gate_bound');
    queueMicrotask(() => wake('pin_gate_microtask'));
    const frame = window.requestAnimationFrame(() => wake('pin_gate_next_frame'));
    const shortTimer = window.setTimeout(() => wake('pin_gate_bubbles_mounted'), 80);

    recordEnrollment('E2EE_DEVICE_ENROLL_START', 'started', 'post_pin_bound');

    void runDeviceOperation(`pin-fast-maintenance:${userId}:${deviceId}`, async () => {
      await requireAuthenticatedDeviceSession(userId);
      recordEnrollment('E2EE_DEVICE_ENROLL_AUTH_READY', 'ready', 'auth_session');

      const hydrated = await hydrateDeviceId();
      if (hydrated !== deviceId) throw new Error('DEVICE_ID_MISMATCH');
      let stableDeviceId = hydrated;

      try {
        const stable = await recoverStableDeviceLifecycle(userId, stableDeviceId);
        stableDeviceId = stable.deviceId;
      } catch {
        recordEnrollment('E2EE_DEVICE_LIFECYCLE_DEFERRED', 'deferred', 'device_lifecycle', 'warning');
      }

      let route = await inspectCurrentDeviceRoute(userId, stableDeviceId);
      recordEnrollment('E2EE_DEVICE_ROUTE_INSPECTED', route.status, 'route_before_repair', route.ready ? 'info' : 'warning');

      if (!route.ready) {
        if (!route.hasAuthorization) throw new Error('DEVICE_ACCOUNT_BINDING_REQUIRED');
        const report = await resyncE2EE(userId);
        if (report.needsPinUnlock || report.steps.identity !== 'ok' || report.steps.spk !== 'ok') {
          throw new Error('DEVICE_RESYNC_INCOMPLETE');
        }
        if (report.deviceId && report.deviceId !== stableDeviceId) {
          // V2 invariant: account maintenance may never silently replace a logical DeviceID.
          throw new Error('DEVICE_ID_MISMATCH');
        }

        await markCurrentRouteReady(stableDeviceId);
        route = await inspectCurrentDeviceRoute(userId, stableDeviceId);
        if (!route.ready) throw new Error('DEVICE_ROUTE_NOT_READY_AFTER_RESYNC');
        recordEnrollment('E2EE_DEVICE_ENROLL_REPAIRED', 'ready', 'route_after_resync');
      }

      const repairedCompanions = await ensureApprovedDeviceTrust(userId, stableDeviceId);
      invalidateAllFanoutRoutes();
      recordEnrollment('E2EE_DEVICE_ENROLL_READY', 'ready', 'complete');
      await flushCryptoErrors();
      console.info('[PIN-DEVTRUST] bound maintenance complete', { route: route.status, repairedCompanions });
      wake('pin_fast_maintenance_complete');
    }, { coalesce: true, cooldownMs: 2_000 }).catch(async (error) => {
      const failureMessage = error instanceof Error ? error.message : String(error ?? '');
      const failureCode = failureMessage
        .split(':')
        .map(part => part.trim())
        .find(part => /^[A-Z][A-Z0-9_]{2,80}$/.test(part))
        ?? 'UNKNOWN';
      recordEnrollment('E2EE_DEVICE_ENROLL_FAILED', classifyEnrollmentFailure(error), 'complete', 'error', failureCode);
      await flushCryptoErrors().catch(() => undefined);
      console.warn('[PIN-DEVTRUST] maintenance unavailable', failureCode);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(shortTimer);
    };
  }, [bindingReady, deviceId, user?.id]);

  return <>{children}</>;
}
