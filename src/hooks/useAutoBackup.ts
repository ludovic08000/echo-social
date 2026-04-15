/**
 * useAutoBackup — Automatically backs up E2EE keys after changes
 * 
 * Uses recovery key model: the recovery key lives ONLY in a volatile JS ref
 * (cleared on tab close / GC). Never persisted anywhere.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { useSecureBackup } from '@/hooks/useSecureBackup';
import { openE2EEDB } from '@/lib/crypto/indexedDb';

const BACKUP_CHECK_KEY = 'forsure-backup-active';
const DEBOUNCE_MS = 5_000;

export function useAutoBackup() {
  const { user } = useAuth();
  const { updateBackup } = useSecureBackup();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Recovery key lives ONLY in memory — never persisted
  const recoveryKeyRef = useRef<string | null>(null);
  const [hasKey, setHasKey] = useState(false);

  // On mount, check if a backup session was active (flag only, no key)
  useEffect(() => {
    try {
      const active = sessionStorage.getItem(BACKUP_CHECK_KEY);
      if (active === '1' && recoveryKeyRef.current) {
        setHasKey(true);
      }
    } catch {}
  }, []);

  /** Set the recovery key for this session (called once after backup creation) */
  const setRecoveryKey = useCallback((key: string) => {
    recoveryKeyRef.current = key;
    setHasKey(true);
    try {
      sessionStorage.setItem(BACKUP_CHECK_KEY, '1');
    } catch {}
  }, []);

  /** Clear the recovery key from memory */
  const clearRecoveryKey = useCallback(() => {
    recoveryKeyRef.current = null;
    setHasKey(false);
    try {
      sessionStorage.removeItem(BACKUP_CHECK_KEY);
    } catch {}
  }, []);

  /** Trigger a debounced backup update */
  const triggerBackup = useCallback(() => {
    if (!user || !recoveryKeyRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        console.log('[AutoBackup] Auto-backing up keys...');
        await updateBackup(recoveryKeyRef.current!);
        console.log('[AutoBackup] ✅ Auto-backup complete');
      } catch (e) {
        console.warn('[AutoBackup] Failed:', e);
      }
    }, DEBOUNCE_MS);
  }, [user, updateBackup]);

  // Watch IndexedDB changes via polling
  useEffect(() => {
    if (!user || !hasKey) return;

    let lastHash = '';

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
        if (lastHash && hash !== lastHash) {
          triggerBackup();
        }
        lastHash = hash;
      } catch {}
    };

    const interval = setInterval(checkForChanges, 30_000);
    checkForChanges();

    return () => {
      clearInterval(interval);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [user, hasKey, triggerBackup]);

  return { setRecoveryKey, clearRecoveryKey, triggerBackup, hasKey };
}
