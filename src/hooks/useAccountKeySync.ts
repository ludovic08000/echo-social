/**
 * useAccountKeySync — Automatic E2EE key backup tied to user account
 * 
 * - On login: derives encryption key from password, auto-restores keys if missing
 * - During session: watches for key changes via content-based digest and auto-syncs
 * - On logout: clears derived key from memory
 * - On native (iOS/Android): hydrates device id from Capacitor Preferences and
 *   triggers a sync when the app resumes from background.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import {
  syncBackupToServer,
  isAutoBackupActive,
  clearAccountKeySession,
  hasLocalKeys,
  computeLocalCryptoDigest,
  restoreAccountKeysFromActiveSession,
} from '@/lib/crypto/accountKeyBackup';
import { hydrateDeviceId } from '@/lib/messaging/currentDevice';
import { isNativePlatform } from '@/lib/nativeStore';

const SYNC_DEBOUNCE_MS = 5_000;
// Mobile WebViews can be paused — poll a bit more aggressively when foregrounded.
const POLL_INTERVAL_MS = isNativePlatform() ? 20_000 : 30_000;

export function useAccountKeySync() {
  const { user } = useAuth();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDigestRef = useRef('');

  const triggerSync = useCallback(() => {
    if (!isAutoBackupActive()) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        await syncBackupToServer();
      } catch (e) {
        console.warn('[AccountKeySync] Auto-sync failed:', e);
      }
    }, SYNC_DEBOUNCE_MS);
  }, []);

  // Hydrate the persistent device id + verify Keychain/Keystore health at boot.
  useEffect(() => {
    void (async () => {
      try {
        const { verifySecureStoreHealth } = await import('@/lib/secureStore');
        const health = await verifySecureStoreHealth([
          'forsure-device-id-v1',
          'forsure-key-sentinel-v1',
        ]);
        if (health.tier !== 'keychain' && isNativePlatform()) {
          console.warn('[AccountKeySync] secure storage degraded — running on fallback tier:', health.tier, health.warnings);
        }
        if (health.driftedKeys.length > 0) {
          console.warn('[AccountKeySync] secure storage drift reconciled:', health.driftedKeys);
        }
      } catch (e) {
        console.warn('[AccountKeySync] secure store health check failed:', e);
      }
      try {
        const id = await hydrateDeviceId();
        console.log('[AccountKeySync] device id hydrated:', id.slice(0, 8));
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    void (async () => {
      try {
        const [{ hasWrappedKeys }, { hasRawIdentityKeys }] = await Promise.all([
          import('@/lib/crypto/pinWrap'),
          import('@/lib/crypto/keyManager'),
        ]);

        const [localKeysPresent, rawIdentityPresent, wrappedKeysPresent] = await Promise.all([
          hasLocalKeys(),
          hasRawIdentityKeys(user.id),
          hasWrappedKeys(user.id),
        ]);

        console.log('[messaging] crypto startup check', {
          userId: user.id,
          localKeysPresent,
          rawIdentityPresent,
          wrappedKeysPresent,
          autoBackupActive: isAutoBackupActive(),
          native: isNativePlatform(),
        });

        if (cancelled || rawIdentityPresent) return;

        if (wrappedKeysPresent) {
          console.warn('[messaging] local crypto exists but is locked behind PIN — waiting for unlock');
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

        // Cold-start path (iOS/Android most often): no in-memory password,
        // IndexedDB empty. Use the secure sentinel to detect a server backup
        // bound to this device and surface a precise restore prompt.
        try {
          const { readKeySentinel } = await import('@/lib/crypto/keySentinel');
          const sentinel = await readKeySentinel();

          if (sentinel && sentinel.userId === user.id) {
            // Confirm a backup actually exists on the server before prompting.
            const { data: backupRow } = await supabase
              .from('user_backups' as any)
              .select('id, version, backup_type, created_at')
              .eq('user_id', user.id)
              .eq('backup_type', 'account')
              .maybeSingle();

            if (cancelled) return;

            if (backupRow) {
              console.log('[messaging] cold-start sentinel matched — server backup confirmed', {
                userId: user.id,
                lastSyncAt: new Date(sentinel.lastSyncAt).toISOString(),
                native: isNativePlatform(),
              });
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

            console.warn('[messaging] sentinel present but no server backup row — stale sentinel');
          } else if (sentinel && sentinel.userId !== user.id) {
            console.warn('[messaging] sentinel bound to a different user — ignoring', {
              sentinelUser: sentinel.userId.slice(0, 8),
              currentUser: user.id.slice(0, 8),
            });
          }
        } catch (e) {
          console.warn('[messaging] sentinel cold-start check failed:', e);
        }

        if (restoreStatus === 'unavailable') {
          console.warn('[messaging] no automatic crypto restore available in this session — explicit restore required');
        }
      } catch (e) {
        console.warn('[messaging] startup crypto check failed:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Poll for IndexedDB changes using content-based digest
  useEffect(() => {
    if (!user || !isAutoBackupActive()) return;

    const checkForChanges = async () => {
      try {
        const digest = await computeLocalCryptoDigest();
        if (lastDigestRef.current && digest !== lastDigestRef.current) {
          console.log('[AccountKeySync] Crypto state changed, triggering sync');
          triggerSync();
        }
        lastDigestRef.current = digest;
      } catch {}
    };

    const interval = setInterval(checkForChanges, POLL_INTERVAL_MS);
    checkForChanges();

    return () => {
      clearInterval(interval);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [user, triggerSync]);

  // Native: re-sync when the app resumes from background, and on visibility change.
  useEffect(() => {
    if (!user) return;

    let unsubscribeApp: (() => void) | null = null;

    const onResume = () => {
      console.log('[AccountKeySync] app resumed — re-checking crypto');
      void (async () => {
        try {
          const digest = await computeLocalCryptoDigest();
          lastDigestRef.current = digest;
          if (isAutoBackupActive()) {
            // Force a sync attempt right away on resume
            triggerSync();
          }
          // Re-attempt restore if local keys vanished (iOS WebView purge)
          if (!(await hasLocalKeys())) {
            const status = await restoreAccountKeysFromActiveSession(user.id);
            if (status === 'restored') {
              window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
                detail: { status: 'restored_on_resume' },
              }));
            }
          }
        } catch (e) {
          console.warn('[AccountKeySync] resume handler failed:', e);
        }
      })();
    };

    // Web: visibilitychange covers tab refocus
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onResume();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Native: subscribe to Capacitor App resume events
    if (isNativePlatform()) {
      void import('@capacitor/app').then(({ App }) => {
        const handle = App.addListener('resume', onResume);
        unsubscribeApp = () => {
          // Capacitor 7 returns a promise from addListener
          Promise.resolve(handle).then((h: any) => h?.remove?.()).catch(() => {});
        };
      }).catch((e) => {
        console.warn('[AccountKeySync] @capacitor/app unavailable:', e);
      });
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (unsubscribeApp) unsubscribeApp();
    };
  }, [user, triggerSync]);

  // Cleanup on logout
  useEffect(() => {
    if (!user) {
      clearAccountKeySession();
      lastDigestRef.current = '';
    }
  }, [user]);

  return { triggerSync, isActive: isAutoBackupActive() };
}
