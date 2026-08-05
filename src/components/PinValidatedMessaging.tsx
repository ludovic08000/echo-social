import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { ensureApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { flushCryptoErrors, logCryptoError } from '@/lib/crypto/errorLogger';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import { getCurrentPlatform } from '@/lib/messaging/currentDevice';
import {
  getCurrentDeviceId,
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
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { reason, deviceId },
    }));
    window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
      detail: { reason, deviceId },
    }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { status: 'pin_unlocked', reason, deviceId },
    }));
  } catch {
    // Browser event dispatch is best-effort during teardown/SSR.
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
  if (/REGISTER|DEVICE_AUTH|IDENTITY/i.test(message)) return 'device_identity';
  if (/FETCH|NETWORK|TIMEOUT|429|5\d\d/i.test(message)) return 'network';
  return 'unknown';
}

async function inspectCurrentDeviceRoute(
  userId: string,
  deviceId: string,
): Promise<DeviceRouteInspection> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id,is_active,revoked_at,stale_at,approval_status,routing_status,device_authorization_signature')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) throw new Error('DEVICE_ROUTE_LOOKUP_FAILED');
  if (!data) {
    return {
      exists: false,
      ready: false,
      hasAuthorization: false,
      hasSignedPrekey: false,
      status: 'missing',
    };
  }

  const hasAuthorization = typeof data.device_authorization_signature === 'string'
    && data.device_authorization_signature.trim().length > 0;
  const hasSignedPrekey = Boolean(
    await peekDeviceSignedPrekey(userId, deviceId).catch(() => null),
  );
  const ready = data.is_active !== false
    && !data.revoked_at
    && !data.stale_at
    && data.approval_status !== 'rejected'
    && data.routing_status === 'ready'
    && hasAuthorization
    && hasSignedPrekey;

  return {
    exists: true,
    ready,
    hasAuthorization,
    hasSignedPrekey,
    status: ready ? 'ready' : 'incomplete',
  };
}

async function markCurrentRouteReady(deviceId: string): Promise<void> {
  const { data, error } = await supabase.rpc(
    'mark_current_device_route_ready' as never,
    { p_device_id: deviceId } as never,
  );
  const result = data as { ok?: boolean; code?: string } | null;
  if (error || result?.ok !== true) {
    throw new Error(`DEVICE_ROUTE_NOT_READY:${result?.code ?? 'RPC_FAILED'}`);
  }
}

/**
 * The local PIN only opens the UI; it never mutates E2EE keys or ratchets.
 * Render conversations immediately. Server/device maintenance is detached and
 * can never replace or delay the message tree.
 */
export function PinValidatedMessaging({ children }: PinValidatedMessagingProps) {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;

    let cancelled = false;
    const userId = user.id;
    const wake = (reason: string) => {
      if (!cancelled) wakeMessageDecryptors(getCurrentDeviceId() || null, reason);
    };

    // Bubble components may subscribe during different React commit phases.
    // Wake every phase without waiting for any network operation.
    wake('pin_gate_opened');
    queueMicrotask(() => wake('pin_gate_microtask'));
    const frame = window.requestAnimationFrame(() => wake('pin_gate_next_frame'));
    const shortTimer = window.setTimeout(() => wake('pin_gate_bubbles_mounted'), 80);

    recordEnrollment('E2EE_DEVICE_ENROLL_START', 'started', 'pin_gate_open');

    void runDeviceOperation(`pin-fast-maintenance:${userId}`, async () => {
      await requireAuthenticatedDeviceSession(userId);
      recordEnrollment('E2EE_DEVICE_ENROLL_AUTH_READY', 'ready', 'auth_session');

      await hydrateDeviceId();
      let deviceId = getCurrentDeviceId();

      try {
        const lifecycle = await recoverStableDeviceLifecycle(userId, deviceId);
        deviceId = lifecycle.deviceId;
      } catch {
        recordEnrollment('E2EE_DEVICE_LIFECYCLE_DEFERRED', 'deferred', 'device_lifecycle', 'warning');
      }

      let route = await inspectCurrentDeviceRoute(userId, deviceId);
      recordEnrollment(
        'E2EE_DEVICE_ROUTE_INSPECTED',
        route.status,
        'route_before_repair',
        route.ready ? 'info' : 'warning',
      );

      if (!route.ready) {
        const report = await resyncE2EE(userId);
        if (
          report.needsPinUnlock
          || report.steps.identity !== 'ok'
          || report.steps.spk !== 'ok'
        ) {
          throw new Error('DEVICE_RESYNC_INCOMPLETE');
        }

        // A fresh registration starts in `repairing`. The restore path must
        // explicitly certify the route after the signed prekey is published.
        await markCurrentRouteReady(deviceId);
        route = await inspectCurrentDeviceRoute(userId, deviceId);
        if (!route.ready) throw new Error('DEVICE_ROUTE_NOT_READY_AFTER_RESYNC');

        recordEnrollment('E2EE_DEVICE_ENROLL_REPAIRED', 'ready', 'route_after_resync');
      }

      const repairedCompanions = await ensureApprovedDeviceTrust(userId, deviceId);
      invalidateAllFanoutRoutes();

      recordEnrollment('E2EE_DEVICE_ENROLL_READY', 'ready', 'complete');
      await flushCryptoErrors();

      console.info('[PIN-DEVTRUST] fast maintenance complete', {
        route: route.status,
        repairedCompanions,
      });

      wake('pin_fast_maintenance_complete');
    }, { coalesce: true, cooldownMs: 2_000 }).catch(async (error) => {
      const failureMessage = error instanceof Error ? error.message : String(error ?? '');
      const failureCode = failureMessage
        .split(':')
        .map(part => part.trim())
        .find(part => /^[A-Z][A-Z0-9_]{2,80}$/.test(part))
        ?? 'UNKNOWN';
      recordEnrollment(
        'E2EE_DEVICE_ENROLL_FAILED',
        classifyEnrollmentFailure(error),
        'complete',
        'error',
        failureCode,
      );
      await flushCryptoErrors().catch(() => undefined);
      console.warn('[PIN-DEVTRUST] fast maintenance unavailable');
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(shortTimer);
    };
  }, [user?.id]);

  return <>{children}</>;
}
