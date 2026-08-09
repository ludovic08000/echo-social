/**
 * useAccountKeySync — account-bound E2EE key backup/restore.
 *
 * Device identity lifecycle is deliberately NOT managed here. This hook runs
 * only after the canonical device/PIN/binding gates have admitted the crypto
 * runtime. DeviceID enrollment, approval and prekeys remain deviceApi concerns.
 */

import { useCallback, useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import {
  clearAccountKeySession,
  hasLocalKeys,
  restoreAccountKeysFromActiveSession,
  restoreKeysFromKeychainSnapshot,
  syncKeychainSnapshotFromLocal,
  restoreFromInMemoryMasterKey,
} from '@/lib/crypto/accountKeyBackup';
import { isNativePlatform } from '@/lib/nativeStore';
import { transition, withEnsureLock, getSnapshot } from '@/lib/crypto/CryptoStateMachine';
import { cryptoApi } from '@/lib/api/cryptoApi';

export function useAccountKeySync() {
  const { user } = useAuth();

  const triggerSync = useCallback(() => {
    // Automatic server backup remains paused while the E2EE core is stabilised.
    // Manual backup controls call their explicit backup actions.
  }, []);

  // Secure-store health only. DeviceID hydration/recovery is not allowed here.
  useEffect(() => {
    void (async () => {
      try {
        const { verifySecureStoreHealth } = await import('@/lib/secureStore');
        const health = await verifySecureStoreHealth([
          'forsure-device-id-v1',
          'forsure-key-sentinel',
        ]);
        if (health.tier !== 'keychain' && isNativePlatform()) {
          console.warn('[AccountKeySync] secure storage degraded:', health.tier, health.warnings);
        }
        if (health.driftedKeys.length > 0) {
          console.warn('[AccountKeySync] secure storage drift reconciled:', health.driftedKeys);
        }
      } catch (e) {
        console.warn('[AccountKeySync] secure store health check failed:', e);
      }
    })();
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    void withEnsureLock(user.id, async () => {
      try {
        transition(user.id, 'storage_checking', 'useAccountKeySync.boot');
      } catch {
        // A concurrent bootstrap may already own this transition.
      }

      try {
        const [{ hasWrappedKeys }, { hasRawIdentityKeys }] = await Promise.all([
          import('@/lib/crypto/pinWrap'),
          import('@/lib/crypto/keyManager'),
        ]);

        const [localKeysPresent, rawIdentityPresent, wrappedKeysPresent] = await Promise.all([
          hasLocalKeys(user.id),
          hasRawIdentityKeys(user.id),
          hasWrappedKeys(user.id),
        ]);

        console.log('[messaging] crypto startup check', {
          userId: user.id,
          localKeysPresent,
          rawIdentityPresent,
          wrappedKeysPresent,
          native: isNativePlatform(),
        });

        if (rawIdentityPresent) {
          await syncKeychainSnapshotFromLocal(user.id);
          const keychainStatus = await restoreKeysFromKeychainSnapshot(user.id);
          if (keychainStatus === 'restored' && !cancelled) {
            window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
              detail: { status: 'refreshed_from_keychain_snapshot' },
            }));
          }
          return;
        }

        if (cancelled) return;

        const keychainStatus = await restoreKeysFromKeychainSnapshot(user.id);
        if (cancelled) return;

        if (keychainStatus === 'restored') {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: 'restored_from_keychain_snapshot' },
          }));
          return;
        }

        if (wrappedKeysPresent) {
          console.warn('[messaging] local crypto is locked behind PIN — waiting for unlock');
          return;
        }

        const restoreStatus = await restoreAccountKeysFromActiveSession(user.id);
        if (cancelled) return;

        console.log('[messaging] active-session restore status:', restoreStatus);

        if (restoreStatus === 'restored') {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: 'restored_active_session' },
          }));
          return;
        }

        // Cold start: if a secure sentinel confirms an account backup exists,
        // request explicit restoration. This never creates or recovers DeviceID.
        try {
          const { readKeySentinel } = await import('@/lib/crypto/keySentinel');
          const sentinel = await readKeySentinel();

          if (sentinel && sentinel.userId === user.id) {
            const { data: backupRow } = await supabase
              .from('user_backups')
              .select('id, backup_type, created_at')
              .eq('user_id', user.id)
              .eq('backup_type', 'account')
              .maybeSingle();

            if (cancelled) return;

            if (backupRow) {
              window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
                detail: {
                  userId: user.id,
                  reason: 'cold_start_sentinel',
                  source: 'secure_sentinel',
                  lastSyncAt: sentinel.lastSyncAt,
                  native: isNativePlatform(),
                },
              }));
              return;
            }

            console.warn('[messaging] stale key sentinel: no account backup row');
          } else if (sentinel && sentinel.userId !== user.id) {
            console.warn('[messaging] key sentinel belongs to another account — ignored');
          }
        } catch (e) {
          console.warn('[messaging] sentinel cold-start check failed:', e);
        }

        if (restoreStatus === 'unavailable') {
          console.warn('[messaging] no automatic crypto restore available — explicit restore required');
        }
      } catch (e) {
        console.warn('[messaging] startup crypto check failed:', e);
      }

      try {
        const snap = getSnapshot(user.id);
        if (snap.state === 'storage_checking') {
          transition(
            user.id,
            await hasLocalKeys(user.id) ? 'identity_loaded' : 'backup_restore_required',
            'boot.fallback',
          );
        }
      } catch {
        // State-machine fallback is best-effort.
      }
    });

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Detect loss of encrypted local key material during an admitted session.
  // Restore sources are account-key sources only; DeviceID is never repaired here.
  useEffect(() => {
    if (!user) return;

    const PURGE_WATCHDOG_MS = 8_000;

    const checkForChanges = async () => {
      try {
        if (await hasLocalKeys(user.id)) return;

        let recovered = false;
        try {
          recovered = (await restoreKeysFromKeychainSnapshot(user.id)) === 'restored';
        } catch {
          // Continue.
        }
        if (!recovered) {
          try {
            recovered = (await restoreFromInMemoryMasterKey(user.id)) === 'restored';
          } catch {
            // Continue.
          }
        }
        if (!recovered) {
          try {
            recovered = (await restoreAccountKeysFromActiveSession(user.id)) === 'restored';
          } catch {
            // Retry on the next watchdog pass.
          }
        }
        if (recovered) {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: 'watchdog_silent_restore' },
          }));
        }
      } catch {
        // Watchdog remains non-disruptive.
      }
    };

    const interval = window.setInterval(checkForChanges, PURGE_WATCHDOG_MS);
    void checkForChanges();
    return () => window.clearInterval(interval);
  }, [user, triggerSync]);

  // Native/web resume checks restore only account key material.
  useEffect(() => {
    if (!user) return;

    let unsubscribeApp: (() => void) | null = null;

    const attemptSilentRestore = async (origin: string): Promise<boolean> => {
      if (await hasLocalKeys(user.id)) return true;

      try {
        if ((await restoreKeysFromKeychainSnapshot(user.id)) === 'restored') {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_from_keychain_${origin}` },
          }));
          return true;
        }
      } catch {
        // Continue.
      }

      try {
        if ((await restoreFromInMemoryMasterKey(user.id)) === 'restored') {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_from_inmem_mk_${origin}` },
          }));
          return true;
        }
      } catch {
        // Continue.
      }

      try {
        if ((await restoreAccountKeysFromActiveSession(user.id)) === 'restored') {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_from_password_${origin}` },
          }));
          return true;
        }
      } catch {
        // Retry later.
      }

      return false;
    };

    const onResume = () => {
      void attemptSilentRestore('resume').catch((e) => {
        console.warn('[AccountKeySync] resume restore failed:', e);
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') onResume();
    };
    document.addEventListener('visibilitychange', onVisibility);

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
          console.warn('[AccountKeySync] @capacitor/app unavailable:', e);
        });
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeApp?.();
    };
  }, [user, triggerSync]);

  // A restored account key may make the canonical crypto API ready; no direct
  // Supabase device/prekey repair, resync engine or DeviceID hydration lives here.
  useEffect(() => {
    if (!user) return;

    const onKeysRestored = () => {
      void cryptoApi.ensureReady(user.id).catch((e) => {
        console.warn('[AccountKeySync] cryptoApi.ensureReady failed:', e);
      });
    };

    window.addEventListener('forsure-keys-restored', onKeysRestored as EventListener);
    return () => {
      window.removeEventListener('forsure-keys-restored', onKeysRestored as EventListener);
    };
  }, [user]);

  useEffect(() => {
    if (!user) clearAccountKeySession();
  }, [user]);

  return { triggerSync, isActive: false };
}
