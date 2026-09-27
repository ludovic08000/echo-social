/**
 * Surveillance post-runtime des clés de compte.
 *
 * Invariant cryptographique : ce hook est monté UNIQUEMENT après l'admission
 * du runtime (MESSAGING_READY). Il ne relance jamais la séquence boot et ne
 * remet jamais l'état du cycle de vie en arrière : il se contente de détecter
 * une purge locale pendant la session et de retenter une restauration
 * silencieuse. La vraie synchronisation avant runtime vit dans
 * `synchronizeAccountKeysBeforeRuntime`.
 */
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import {
  clearAccountKeySession,
  hasAccountMasterKeySession,
  hasLocalKeys,
  restoreAccountMasterKeyFromDeviceStore,
  restoreAccountKeysFromActiveSession,
  restoreKeysFromKeychainSnapshot,
  restoreFromInMemoryMasterKey,
} from '@/lib/crypto/accountKeyBackup';
import { isNativePlatform } from '@/lib/nativeStore';
import { cryptoApi } from '@/lib/api/cryptoApi';

const PURGE_WATCHDOG_MS = 8_000;

export function useAccountKeyWatchdog() {
  const { user } = useAuth();

  useEffect(() => {
    void (async () => {
      try {
        const { verifySecureStoreHealth } = await import('@/lib/secureStore');
        const health = await verifySecureStoreHealth([
          'forsure-device-id-v1',
          'forsure-key-sentinel',
        ]);
        if (health.tier !== 'keychain' && isNativePlatform()) {
          console.warn('[AccountKeyWatchdog] secure storage degraded:', health.tier, health.warnings);
        }
        if (health.driftedKeys.length > 0) {
          console.warn('[AccountKeyWatchdog] secure storage drift reconciled:', health.driftedKeys);
        }
      } catch (e) {
        console.warn('[AccountKeyWatchdog] secure store health check failed:', e);
      }
    })();
  }, []);

  useEffect(() => {
    if (!user) return;

    const attemptSilentRestore = async (origin: string): Promise<boolean> => {
      let localKeysPresent = await hasLocalKeys(user.id);
      if (localKeysPresent && hasAccountMasterKeySession(user.id)) return true;

      try {
        const status = await restoreAccountMasterKeyFromDeviceStore(user.id);
        localKeysPresent = await hasLocalKeys(user.id);
        if ((status === 'restored' || status === 'local_ok') &&
          localKeysPresent && hasAccountMasterKeySession(user.id)) {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_master_key_from_device_${origin}` },
          }));
          return true;
        }
      } catch {
        // Continue with the password/keychain recovery paths.
      }

      try {
        if ((await restoreKeysFromKeychainSnapshot(user.id)) === 'restored') {
          localKeysPresent = true;
        }
      } catch {
        // Continue.
      }

      try {
        const restored = await restoreFromInMemoryMasterKey(user.id);
        if ((restored === 'restored' || restored === 'local_ok') &&
          hasAccountMasterKeySession(user.id)) {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_from_inmem_mk_${origin}` },
          }));
          return true;
        }
      } catch {
        // Continue.
      }

      try {
        const restored = await restoreAccountKeysFromActiveSession(user.id);
        if ((restored === 'restored' || restored === 'local_ok') &&
          hasAccountMasterKeySession(user.id)) {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_from_password_${origin}` },
          }));
          return true;
        }
      } catch {
        // Retry on the next pass.
      }

      if (localKeysPresent && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
          detail: { userId: user.id, reason: 'account_master_key_locked', source: origin },
        }));
      }

      return false;
    };

    const interval = window.setInterval(() => {
      void attemptSilentRestore('watchdog').catch(() => undefined);
    }, PURGE_WATCHDOG_MS);

    const onResume = () => {
      void attemptSilentRestore('resume').catch((e) => {
        console.warn('[AccountKeyWatchdog] resume restore failed:', e);
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onResume();
    };
    document.addEventListener('visibilitychange', onVisibility);

    let unsubscribeApp: (() => void) | null = null;
    if (isNativePlatform()) {
      void import('@capacitor/app')
        .then(({ App }) => {
          const handle = App.addListener('resume', onResume);
          unsubscribeApp = () => {
            Promise.resolve(handle)
              .then((listener) => listener.remove())
              .catch(() => undefined);
          };
        })
        .catch((e) => {
          console.warn('[AccountKeyWatchdog] @capacitor/app unavailable:', e);
        });
    }

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeApp?.();
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const onKeysRestored = () => {
      void cryptoApi.ensureReady(user.id).catch((e) => {
        console.warn('[AccountKeyWatchdog] cryptoApi.ensureReady failed:', e);
      });
    };
    window.addEventListener('forsure-keys-restored', onKeysRestored as EventListener);
    return () => window.removeEventListener('forsure-keys-restored', onKeysRestored as EventListener);
  }, [user]);

  useEffect(() => {
    if (!user) clearAccountKeySession();
  }, [user]);
}
