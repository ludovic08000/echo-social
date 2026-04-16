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
