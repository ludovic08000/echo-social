import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { repairApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { publishOwnSignedDeviceList } from '@/lib/crypto/signedDeviceList';
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
    window.dispatchEvent(new CustomEvent('forsure:e2ee-request-refanout-scan', {
      detail: { reason, deviceId },
    }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { status: 'pin_unlocked', reason, deviceId },
    }));
  } catch {}
}

/**
 * The outer MessagingPinGate renders this component only after verifyPin()
 * successfully restored the local crypto blob. Device registration, Signed
 * PreKey maintenance and companion trust are network maintenance tasks: they
 * must never hide an already-restorable local conversation.
 */
export function PinValidatedMessaging({ children }: PinValidatedMessagingProps) {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;

    let cancelled = false;
    const userId = user.id;

    // The bubbles mount on this render. Wake decryptors now and once more after
    // React has committed the message tree so cached encrypted rows are retried.
    wakeMessageDecryptors(getCurrentDeviceId() || null, 'pin_gate_opened');
    const retryTimer = window.setTimeout(() => {
      if (!cancelled) {
        wakeMessageDecryptors(getCurrentDeviceId() || null, 'pin_gate_bubbles_mounted');
      }
    }, 250);

    // Best-effort maintenance only. Failure is logged but never replaces the
    // conversation with a repair screen.
    void runDeviceOperation(`pin-post-unlock-maintenance:${userId}`, async () => {
      await requireAuthenticatedDeviceSession(userId);
      await hydrateDeviceId();
      const deviceId = getCurrentDeviceId();

      try {
        await recoverStableDeviceLifecycle(userId, deviceId);
      } catch (error) {
        console.warn('[PIN-DEVTRUST] lifecycle maintenance deferred', {
          deviceId: deviceId.slice(0, 8),
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await resyncE2EE(userId);
      } catch (error) {
        console.warn('[PIN-DEVTRUST] prekey/resync maintenance deferred', {
          deviceId: deviceId.slice(0, 8),
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const repaired = await repairApprovedDeviceTrust(userId);
        const published = await publishOwnSignedDeviceList();
        console.info('[PIN-DEVTRUST] background maintenance complete', {
          userId: userId.slice(0, 8),
          deviceId: getCurrentDeviceId().slice(0, 8),
          repaired,
          published: published.ok,
        });
      } catch (error) {
        console.warn('[PIN-DEVTRUST] companion maintenance deferred', {
          deviceId: getCurrentDeviceId().slice(0, 8),
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (!cancelled) {
        wakeMessageDecryptors(getCurrentDeviceId() || null, 'pin_background_maintenance_complete');
      }
    }, { coalesce: true }).catch((error) => {
      console.warn('[PIN-DEVTRUST] post-unlock maintenance unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [user?.id]);

  return <>{children}</>;
}
