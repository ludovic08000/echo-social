/**
 * useAccountKeySync — Automatic E2EE key backup tied to user account
 * 
 * - On login: derives encryption key from password, auto-restores keys if missing
 * - During session: watches for key changes via content-based digest and auto-syncs
 * - On logout: clears derived key from memory
 */

import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import {
  syncBackupToServer,
  isAutoBackupActive,
  clearAccountKeySession,
  hasLocalKeys,
  computeLocalCryptoDigest,
  restoreAccountKeysFromActiveSession,
} from '@/lib/crypto/accountKeyBackup';

const SYNC_DEBOUNCE_MS = 5_000;
const POLL_INTERVAL_MS = 30_000;

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

  // Cleanup on logout
  useEffect(() => {
    if (!user) {
      clearAccountKeySession();
      lastDigestRef.current = '';
    }
  }, [user]);

  return { triggerSync, isActive: isAutoBackupActive() };
}
