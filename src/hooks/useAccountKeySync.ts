/**
 * useAccountKeySync — Automatic E2EE key backup tied to user account
 * 
 * - On login: derives encryption key from password, auto-restores keys if missing
 * - During session: watches for key changes via content-based digest and auto-syncs
 * - On logout: clears derived key from memory
 * - On native (iOS/Android): hydrates device id from Capacitor Preferences and
 *   triggers a sync when the app resumes from background.
 */

import { useEffect, useCallback } from 'react';
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
import { hydrateDeviceId, rotateCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { isNativePlatform } from '@/lib/nativeStore';
import { transition, withEnsureLock, getSnapshot } from '@/lib/crypto/CryptoStateMachine';

export function useAccountKeySync() {
  const { user } = useAuth();

  const triggerSync = useCallback(() => {
    // Automatic server backup is paused while the E2EE core is stabilised.
    // Manual backup controls can still call their explicit backup actions.
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

    // Single-flight guard: concurrent mounts share the same boot promise,
    // and `identity_creating` is hard-locked to once-per-session by the
    // CryptoStateMachine — eliminates the IndexedDB-empty → recreate loop.
    void withEnsureLock(user.id, async () => {
      try { transition(user.id, 'storage_checking', 'useAccountKeySync.boot'); } catch {}
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
          autoBackupActive: false,
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
      try {
        const snap = getSnapshot(user.id);
        if (snap.state === 'storage_checking') {
          transition(user.id, await hasLocalKeys() ? 'identity_loaded' : 'backup_restore_required', 'boot.fallback');
        }
      } catch {}
    });

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Poll for IndexedDB changes + WATCHDOG: detect mid-session storage purge.
  // iOS Safari/PWA can wipe IndexedDB silently while the app stays open
  // (ITP, low storage, "Clear data"). We poll fast (8 s) and silently rebuild
  // local keys from in-RAM Master Key → Keychain → password. No UI surface.
  useEffect(() => {
    if (!user) return;

    const PURGE_WATCHDOG_MS = 8_000;

    const checkForChanges = async () => {
      try {
        // Watchdog first: if IndexedDB lost the identity, recover NOW.
        if (!(await hasLocalKeys())) {
          // Try keychain → in-RAM master key → password (all silent).
          let recovered = false;
          try {
            recovered = (await restoreKeysFromKeychainSnapshot(user.id)) === 'restored';
          } catch {}
          if (!recovered) {
            try {
              recovered = (await restoreFromInMemoryMasterKey(user.id)) === 'restored';
            } catch {}
          }
          if (!recovered) {
            try {
              recovered = (await restoreAccountKeysFromActiveSession(user.id)) === 'restored';
            } catch {}
          }
          if (recovered) {
            console.log('[AccountKeySync] watchdog: silent re-hydration succeeded');
            window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
              detail: { status: 'watchdog_silent_restore' },
            }));
          }
        }

      } catch {}
    };

    const interval = setInterval(checkForChanges, PURGE_WATCHDOG_MS);
    checkForChanges();

    return () => {
      clearInterval(interval);
    };
  }, [user, triggerSync]);

  // Native: re-sync when the app resumes from background, and on visibility change.
  useEffect(() => {
    if (!user) return;

    let unsubscribeApp: (() => void) | null = null;

    const attemptSilentRestore = async (origin: string): Promise<boolean> => {
      if (await hasLocalKeys()) return true;
      // 1) Native Keychain snapshot (survives IndexedDB purge on iOS)
      try {
        const k = await restoreKeysFromKeychainSnapshot(user.id);
        if (k === 'restored') {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_from_keychain_${origin}` },
          }));
          return true;
        }
      } catch {}
      // 2) In-RAM Master Key (no password prompt — works mid-session)
      try {
        const m = await restoreFromInMemoryMasterKey(user.id);
        if (m === 'restored') {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_from_inmem_mk_${origin}` },
          }));
          return true;
        }
      } catch {}
      // 3) In-memory password session
      try {
        const p = await restoreAccountKeysFromActiveSession(user.id);
        if (p === 'restored') {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: `restored_from_password_${origin}` },
          }));
          return true;
        }
      } catch {}
      return false;
    };

    const onResume = () => {
      console.log('[AccountKeySync] app resumed — re-checking crypto');
      void (async () => {
        try {
          await attemptSilentRestore('resume');
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

  // Auto-trigger a full E2EE re-sync whenever keys have just been restored.
  //
  // Robustness layers — all three are needed because the restore event can
  // fire BEFORE this listener mounts (it's emitted from auth.tsx during password
  // unwrap, or from earlier effects in this same hook):
  //   1) live event listener for in-session restores
  //   2) sessionStorage marker so a restore that fired before mount is replayed
  //   3) safety net that runs a resync once per session if the device id is
  //      not yet registered server-side (covers the "no event ever fired" case)
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let inFlight = false;

    const RESYNC_PENDING_KEY = `forsure:e2ee-resync-pending:${user.id}`;
    const RESYNC_DONE_KEY = `forsure:e2ee-resync-done:${user.id}`;
    const RESYNC_HEALTH_KEY = `forsure:e2ee-resync-health:${user.id}`;

    const runResync = async (reason: string, detail: unknown = {}) => {
      if (inFlight) return;
      inFlight = true;
      console.log('[AccountKeySync] running E2EE resync', { reason, detail });
      try {
        // Make sure the persisted device id from native storage wins before
        // we re-publish anything to the server.
        try { await hydrateDeviceId(); } catch {}
        const { resyncE2EE } = await import('@/lib/crypto/resyncE2EE');
        const report = await resyncE2EE(user.id);
        console.log('[AccountKeySync] resync report:', report);
        try {
          sessionStorage.setItem(RESYNC_DONE_KEY, String(Date.now()));
          sessionStorage.removeItem(RESYNC_PENDING_KEY);
        } catch {}
      } catch (e) {
        console.warn('[AccountKeySync] resync failed:', e);
      } finally {
        inFlight = false;
      }
    };

    const onKeysRestored = (ev: Event) => {
      const detail = (ev as CustomEvent).detail ?? {};
      try { sessionStorage.setItem(RESYNC_PENDING_KEY, JSON.stringify({ at: Date.now(), detail })); } catch {}
      void runResync('keys-restored-event', detail);
    };

    window.addEventListener('forsure-keys-restored', onKeysRestored as EventListener);

    // Replay any pending restore event that fired before this listener mounted.
    void (async () => {
      try {
        const pending = sessionStorage.getItem(RESYNC_PENDING_KEY);
        if (pending) {
          await runResync('pending-on-mount', JSON.parse(pending));
          return;
        }
      } catch {}

      // Safety net: if there are local keys but we've never resynced this
      // session AND the current device id isn't registered server-side,
      // run one resync to publish identity/SPK/OPK.
      try {
        if (cancelled) return;
        const done = sessionStorage.getItem(RESYNC_DONE_KEY);
        if (!(await hasLocalKeys())) return;
        let did = await hydrateDeviceId();
        const { data: row } = await supabase
          .from('user_devices')
          .select('device_id,is_active,revoked_at')
          .eq('user_id', user.id)
          .eq('device_id', did)
          .maybeSingle();

        if (row && (row.is_active === false || row.revoked_at)) {
          console.warn('[AccountKeySync] current device is revoked/inactive during health check - rotating before resync', {
            did: did.slice(0, 8),
          });
          did = rotateCurrentDeviceId('account-sync-revoked-device');
        }

        const { data: spkRow } = await supabase
          .from('device_signed_prekeys' as any)
          .select('spk_id')
          .eq('user_id', user.id)
          .eq('device_id', did)
          .eq('is_active', true)
          .maybeSingle();
        if (cancelled) return;

        const registered =
          !!row &&
          row.device_id === did &&
          row.is_active !== false &&
          !row.revoked_at;
        const previousHealth = sessionStorage.getItem(RESYNC_HEALTH_KEY);
        const currentHealth = JSON.stringify({ did, registered, spk: !!spkRow });
        if (!registered || !spkRow || (!done && previousHealth !== currentHealth)) {
          console.warn('[AccountKeySync] E2EE device health incomplete — auto-resync', {
            did: did.slice(0, 8),
            registered,
            deviceSpk: !!spkRow,
          });
          await runResync(!registered ? 'device-not-registered' : 'device-prekeys-missing');
          sessionStorage.setItem(RESYNC_HEALTH_KEY, currentHealth);
        }
      } catch (e) {
        console.warn('[AccountKeySync] safety-net resync check failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('forsure-keys-restored', onKeysRestored as EventListener);
    };
  }, [user?.id]);

  // Cleanup on logout
  useEffect(() => {
    if (!user) {
      clearAccountKeySession();
    }
  }, [user]);

  return { triggerSync, isActive: false };
}
