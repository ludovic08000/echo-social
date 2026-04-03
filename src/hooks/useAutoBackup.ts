/**
 * useAutoBackup — Automatically backs up E2EE keys after changes
 * 
 * Requires a backup password to be set once. After that, keys are
 * re-encrypted and uploaded silently whenever they change.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { useSecureBackup } from '@/hooks/useSecureBackup';

const BACKUP_PASSWORD_KEY = 'forsure-backup-pwd-hash';
const DEBOUNCE_MS = 5_000;

export function useAutoBackup() {
  const { user } = useAuth();
  const { createBackup } = useSecureBackup();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordRef = useRef<string | null>(null);
  const [hasPassword, setHasPassword] = useState(false);

  // Load cached password from session (volatile — cleared on tab close)
  useEffect(() => {
    try {
      const pwd = sessionStorage.getItem(BACKUP_PASSWORD_KEY);
      if (pwd) {
        passwordRef.current = pwd;
        setHasPassword(true);
      }
    } catch {}
  }, []);

  /** Set the backup password for this session (called once by user) */
  const setBackupPassword = useCallback((password: string) => {
    passwordRef.current = password;
    setHasPassword(true);
    try {
      sessionStorage.setItem(BACKUP_PASSWORD_KEY, password);
    } catch {}
  }, []);

  /** Trigger a debounced backup */
  const triggerBackup = useCallback(() => {
    if (!user || !passwordRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        console.log('[AutoBackup] Auto-backing up keys...');
        await createBackup(passwordRef.current!);
        console.log('[AutoBackup] ✅ Auto-backup complete');
      } catch (e) {
        console.warn('[AutoBackup] Failed:', e);
      }
    }, DEBOUNCE_MS);
  }, [user, createBackup]);

  // Watch IndexedDB changes via polling — uses hasPassword state to re-run when password is set
  useEffect(() => {
    if (!user || !hasPassword) return;

    let lastHash = '';

    const checkForChanges = async () => {
      try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('forsure-e2ee', 2);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
        });

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

    // Check every 30s
    const interval = setInterval(checkForChanges, 30_000);
    checkForChanges(); // Initial check

    return () => {
      clearInterval(interval);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [user, hasPassword, triggerBackup]);

  return { setBackupPassword, triggerBackup, hasPassword };
}
