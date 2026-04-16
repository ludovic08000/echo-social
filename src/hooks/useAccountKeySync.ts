/**
 * useAccountKeySync — Automatic E2EE key backup tied to user account
 * 
 * - On login: derives encryption key from password, auto-restores keys if missing
 * - During session: watches for key changes and auto-syncs to server
 * - On logout: clears derived key from memory
 */

import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { 
  syncBackupToServer, 
  isAutoBackupActive, 
  clearAccountKeySession,
  hasLocalKeys 
} from '@/lib/crypto/accountKeyBackup';
import { openE2EEDB } from '@/lib/crypto/indexedDb';

const SYNC_DEBOUNCE_MS = 5_000;
const POLL_INTERVAL_MS = 30_000;

export function useAccountKeySync() {
  const { user } = useAuth();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHashRef = useRef('');

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

  // Poll for IndexedDB changes
  useEffect(() => {
    if (!user || !isAutoBackupActive()) return;

    const checkForChanges = async () => {
      try {
        const db = await openE2EEDB();
        let keyCount = 0;
        for (const storeName of Array.from(db.objectStoreNames)) {
          const tx = db.transaction(storeName, 'readonly');
          const count = await new Promise<number>((resolve, reject) => {
            const req = tx.objectStore(storeName).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          keyCount += count;
        }
        db.close();

        const hash = `${keyCount}`;
        if (lastHashRef.current && hash !== lastHashRef.current) {
          triggerSync();
        }
        lastHashRef.current = hash;
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
      lastHashRef.current = '';
    }
  }, [user]);

  return { triggerSync, isActive: isAutoBackupActive() };
}
