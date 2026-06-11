import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import {
  assessCurrentBrowserDevice,
  trustCurrentDeviceAfterPin,
  type DeviceTrustAssessment,
} from '@/lib/security/browserDeviceTrust';

function emitTrustRequired(userId: string, assessment: DeviceTrustAssessment, source: string) {
  const detail = {
    userId,
    source,
    status: assessment.known ? 'PIN_REQUIRED_FOR_RISK_CHANGE' : 'PIN_REQUIRED_FOR_NEW_DEVICE',
    riskLevel: assessment.riskLevel,
    reasons: assessment.reasons,
    device: assessment.current,
    previous: assessment.previous ?? null,
    message: 'Nouveau navigateur ou changement de contexte détecté. Entrez votre PIN pour autoriser ce device.',
  };

  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-device-trust-required', { detail }));
    window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
      detail: {
        userId,
        reason: detail.status,
        message: detail.message,
      },
    }));
  } catch {
    // non-browser/test
  }
}

function emitTrusted(userId: string) {
  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-device-trusted', { detail: { userId } }));
    window.dispatchEvent(new CustomEvent('forsure:e2ee-resync-complete', { detail: { userId, reason: 'device_trusted' } }));
  } catch {
    // non-browser/test
  }
}

/**
 * Global browser/device trust coordinator.
 *
 * It does not verify the PIN itself. It waits for the existing E2EE/PIN unlock
 * events, then promotes the current browser device to trusted in Supabase.
 */
export function useE2EEDeviceTrust() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const busyRef = useRef(false);
  const lastPromptKeyRef = useRef<string>('');

  const assess = useCallback(async (source: string) => {
    if (!userId || busyRef.current) return;
    busyRef.current = true;
    try {
      const assessment = await assessCurrentBrowserDevice(userId);
      if (!assessment.trusted) {
        const key = `${assessment.current.deviceId}:${assessment.riskLevel}:${assessment.reasons.join(',')}`;
        if (key !== lastPromptKeyRef.current) {
          lastPromptKeyRef.current = key;
          emitTrustRequired(userId, assessment, source);
        }
      }
    } catch (error) {
      console.warn('[E2EE_DEVICE_TRUST] assessment failed', error);
    } finally {
      busyRef.current = false;
    }
  }, [userId]);

  const trustAfterUnlock = useCallback(async (source: string) => {
    if (!userId || busyRef.current) return;
    busyRef.current = true;
    try {
      await trustCurrentDeviceAfterPin({ userId });
      lastPromptKeyRef.current = '';
      emitTrusted(userId);
      await assessCurrentBrowserDevice(userId).catch(() => undefined);
      console.info('[E2EE_DEVICE_TRUST] browser device trusted', { source });
    } catch (error) {
      console.warn('[E2EE_DEVICE_TRUST] trust after PIN unlock failed', error);
    } finally {
      busyRef.current = false;
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    void assess('mount');

    const onKeysUnlocked = () => void trustAfterUnlock('keys-unlocked');
    const onKeysRestored = () => void trustAfterUnlock('keys-restored');
    const onOnline = () => void assess('online');
    const onFocus = () => void assess('focus');
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void assess('visibility');
    };

    window.addEventListener('forsure-keys-unlocked', onKeysUnlocked);
    window.addEventListener('forsure-keys-restored', onKeysRestored);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('forsure-keys-unlocked', onKeysUnlocked);
      window.removeEventListener('forsure-keys-restored', onKeysRestored);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [assess, trustAfterUnlock, userId]);
}
