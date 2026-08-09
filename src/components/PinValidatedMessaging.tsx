import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import { cryptoApi } from '@/lib/api/cryptoApi';
import { flushCryptoErrors, logCryptoError } from '@/lib/crypto/errorLogger';

interface PinValidatedMessagingProps {
  children: ReactNode;
}

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

export function PinValidatedMessaging({ children }: PinValidatedMessagingProps) {
  const { user } = useAuth();
  const lifecycle = useDeviceLifecycle();
  const deviceId = lifecycle.deviceId;

  useEffect(() => {
    if (!user?.id || !deviceId || !lifecycle.pinUnlocked) return;
    if (lifecycle.record?.approvalStatus !== 'approved' || lifecycle.record?.isActive !== true || lifecycle.record?.revokedAt) return;

    let cancelled = false;
    const userId = user.id;

    void cryptoApi.ensureReady(userId)
      .then(async (snapshot) => {
        if (cancelled) return;
        const readyDeviceId = snapshot.device.record?.deviceId ?? deviceId;
        wakeMessageDecryptors(readyDeviceId, 'cryptoApi.ready');
        await flushCryptoErrors().catch(() => undefined);
      })
      .catch(async (error) => {
        const errorCode = error instanceof Error ? error.message : String(error ?? 'CRYPTO_READY_FAILED');
        logCryptoError({
          severity: 'warning',
          context: 'restore',
          errorCode: 'E2EE_CRYPTO_API_NOT_READY',
          errorMessage: errorCode,
          metadata: { stage: 'post_pin', device_id: deviceId },
        });
        await flushCryptoErrors().catch(() => undefined);
        console.warn('[cryptoApi] post-PIN readiness deferred', errorCode);
      });

    return () => {
      cancelled = true;
    };
  }, [deviceId, lifecycle.pinUnlocked, lifecycle.record?.approvalStatus, lifecycle.record?.isActive, lifecycle.record?.revokedAt, user?.id]);

  return <>{children}</>;
}
