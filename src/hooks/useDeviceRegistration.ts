import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { deviceApi } from '@/lib/api/deviceApi';
import { readPinUnlocked } from '@/lib/device-manager/pinUnlockSignal';
import { computeDeviceApprovalFingerprint } from '@/lib/crypto/deviceApprovalFingerprint';

/** Post-approval/post-PIN device key setup only. */
export function useDeviceRegistration() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [localDeviceFingerprint, setLocalDeviceFingerprint] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) {
      setLocalDeviceFingerprint(null);
      return;
    }

    let cancelled = false;

    const run = async () => {
      const snapshot = await deviceApi.getState(user.id);
      const record = snapshot.record;
      if (!record) return;

      if (record.devicePublicKey && record.deviceSigningKey) {
        const fingerprint = await computeDeviceApprovalFingerprint({
          deviceId: record.deviceId,
          devicePublicKey: record.devicePublicKey,
          deviceSigningKey: record.deviceSigningKey,
        }).catch(() => null);
        if (!cancelled) setLocalDeviceFingerprint(fingerprint);
      }

      if (!readPinUnlocked(user.id)) return;
      if (snapshot.state !== 'key_setup_required') return;

      await deviceApi.prepareKeys(user.id);
      if (cancelled) return;
      await queryClient.invalidateQueries({ refetchType: 'none' });
      await queryClient.refetchQueries({ type: 'active' });
      window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
        detail: { source: 'deviceApi.prepareKeys', deviceId: record.deviceId },
      }));
    };

    const safeRun = () => {
      void run().catch((error) => {
        console.warn('[deviceApi] key setup deferred', error);
      });
    };

    safeRun();
    const events = [
      'forsure:device-account-bound',
      'forsure-keys-unlocked',
      'forsure-keys-restored',
      'forsure:device-approved',
    ];
    events.forEach((name) => window.addEventListener(name, safeRun));

    return () => {
      cancelled = true;
      events.forEach((name) => window.removeEventListener(name, safeRun));
    };
  }, [queryClient, user?.id]);

  return { localDeviceFingerprint };
}
