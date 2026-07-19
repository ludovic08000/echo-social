import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { ensureApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
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

function wakeMessageDecryptors(deviceId: string | null, reason: string): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { reason, deviceId },
    }));
    window.dispatchEvent(new CustomEvent('forsure:sesame-route-ready', {
      detail: { reason, deviceId },
    }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { status: 'pin_unlocked', reason, deviceId },
    }));
  } catch {}
}

/**
 * verifyPin() has already restored the local crypto blob before this component
 * exists. Render conversations immediately; server/device maintenance is a
 * detached optimisation and can never replace or delay the message tree.
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

    void runDeviceOperation(`pin-fast-maintenance:${userId}`, async () => {
      await requireAuthenticatedDeviceSession(userId);
      await hydrateDeviceId();
      let deviceId = getCurrentDeviceId();

      try {
        const lifecycle = await recoverStableDeviceLifecycle(userId, deviceId);
        deviceId = lifecycle.deviceId;
      } catch (error) {
        console.warn('[PIN-DEVTRUST] lifecycle maintenance deferred', {
          deviceId: deviceId.slice(0, 8),
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Run independent maintenance concurrently. A valid SPK is left untouched;
      // companion signatures are repaired in one batch by DeviceLinkTrust.
      const [prekeyResult, trustResult] = await Promise.allSettled([
        (async () => {
          const existingSpk = await peekDeviceSignedPrekey(userId, deviceId).catch(() => null);
          if (existingSpk) return 'already-valid';
          await resyncE2EE(userId);
          return 'repaired';
        })(),
        ensureApprovedDeviceTrust(userId, deviceId),
      ]);

      console.info('[PIN-DEVTRUST] fast maintenance complete', {
        userId: userId.slice(0, 8),
        deviceId: getCurrentDeviceId().slice(0, 8),
        prekey: prekeyResult.status === 'fulfilled'
          ? prekeyResult.value
          : `deferred:${String(prekeyResult.reason)}`,
        repairedCompanions: trustResult.status === 'fulfilled'
          ? trustResult.value
          : `deferred:${String(trustResult.reason)}`,
      });

      if (trustResult.status === 'fulfilled') invalidateAllFanoutRoutes();
      wake('pin_fast_maintenance_complete');
    }, { coalesce: true, cooldownMs: 2_000 }).catch((error) => {
      // Cooldown or network failure never affects already-mounted bubbles.
      console.warn('[PIN-DEVTRUST] fast maintenance unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(shortTimer);
    };
  }, [user?.id]);

  return <>{children}</>;
}
