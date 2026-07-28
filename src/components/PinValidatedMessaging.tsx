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

      const trustFailureReason = trustResult.status === 'rejected' ? String(trustResult.reason) : null;
      // IDENTITY_ROOT_MISMATCH is a permanent, non-retryable state: the local
      // identity key genuinely differs from the account's published root and
      // publishCanonicalIdentityRoot() will refuse it every single time until
      // an explicit rotation happens (rotate_user_identity_root RPC / device
      // pairing). Waking decryptors + refetching conversations here just
      // restarts the same failing maintenance pass on every trigger, storming
      // the conversations query with aborted refetches for no benefit.
      const isPermanentIdentityFailure = trustFailureReason !== null && (
        trustFailureReason.includes('IDENTITY_ROOT_MISMATCH') ||
        trustFailureReason.includes('DEVICE_TRUST_ROOT_PUBLISH_FAILED')
      );

      console.info('[PIN-DEVTRUST] fast maintenance complete', {
        userId: userId.slice(0, 8),
        deviceId: getCurrentDeviceId().slice(0, 8),
        prekey: prekeyResult.status === 'fulfilled'
          ? prekeyResult.value
          : `deferred:${String(prekeyResult.reason)}`,
        repairedCompanions: trustResult.status === 'fulfilled'
          ? trustResult.value
          : `deferred:${trustFailureReason}`,
      });

      if (trustResult.status === 'fulfilled') invalidateAllFanoutRoutes();

      if (isPermanentIdentityFailure) {
        console.warn('[PIN-DEVTRUST] identity root permanently mismatched — skipping wake/refetch, explicit rotation required', {
          userId: userId.slice(0, 8),
        });
      } else {
        wake('pin_fast_maintenance_complete');
      }
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
