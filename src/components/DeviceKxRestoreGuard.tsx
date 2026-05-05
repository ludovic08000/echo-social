import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import {
  ensureAutoKeyProvisioning,
  resetAutoKeyProvisioningCache,
  type AutoKeyProvisionResult,
} from '@/lib/crypto/autoKeyProvisioning';
import { startRealtimeKeySync, type RealtimeKeySyncHandle } from '@/lib/crypto/realtimeKeySync';
import { logCryptoError } from '@/lib/crypto/errorLogger';

export function DeviceKxRestoreGuard() {
  const { user } = useAuth();
  const realtimeRef = useRef<RealtimeKeySyncHandle | null>(null);
  const lastStatusRef = useRef<string>('');

  const provision = useCallback(async (reason: string, force = false): Promise<AutoKeyProvisionResult | null> => {
    if (!user?.id) return null;
    const res = await ensureAutoKeyProvisioning(user.id, { reason, force });
    const sig = `${res.status}:${res.reason}:${res.deviceId ?? ''}`;
    if (sig !== lastStatusRef.current) {
      lastStatusRef.current = sig;
      logCryptoError({
        severity: res.status === 'ready' ? 'info' : res.status === 'blocked' ? 'critical' : 'warning',
        context: 'restore',
        errorCode: `DEVICE_KX_GUARD_${res.status.toUpperCase()}`,
        errorMessage: res.reason,
        myDeviceId: res.deviceId,
        metadata: { userId: user.id, reason, fingerprint: res.fingerprint },
      });
    }
    return res;
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      realtimeRef.current?.stop();
      realtimeRef.current = null;
      lastStatusRef.current = '';
      return;
    }

    let cancelled = false;
    void provision('guard_mount', true).then((res) => {
      if (cancelled || !res || res.status !== 'ready') return;
      try {
        window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
          detail: { status: 'device_kx_guard_ready', deviceId: res.deviceId },
        }));
      } catch {
        /* SSR safe */
      }
    });

    realtimeRef.current?.stop();
    realtimeRef.current = startRealtimeKeySync(user.id, {
      onProvision: (reason) => {
        void provision(reason, false);
      },
    });

    return () => {
      cancelled = true;
      realtimeRef.current?.stop();
      realtimeRef.current = null;
    };
  }, [user?.id, provision]);

  useEffect(() => {
    if (!user?.id) return;

    const onKeysRestored = () => {
      resetAutoKeyProvisioningCache(user.id);
      void provision('keys_restored_event', true);
    };
    const onKeysUnlocked = () => {
      resetAutoKeyProvisioningCache(user.id);
      void provision('keys_unlocked_event', true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void provision('visibility_resume');
    };

    window.addEventListener('forsure-keys-restored', onKeysRestored);
    window.addEventListener('forsure-keys-unlocked', onKeysUnlocked);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('forsure-keys-restored', onKeysRestored);
      window.removeEventListener('forsure-keys-unlocked', onKeysUnlocked);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user?.id, provision]);

  return null;
}
