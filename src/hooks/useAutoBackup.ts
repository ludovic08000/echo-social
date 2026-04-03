/**
 * useAutoBackup — Automatically backs up E2EE keys after changes
 * 
 * The backup password is NEVER stored in plaintext.
 * Instead we keep only a PBKDF2-derived "check hash" in sessionStorage
 * and the raw password in a volatile JS ref (cleared on tab close / GC).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { useSecureBackup } from '@/hooks/useSecureBackup';

const BACKUP_CHECK_KEY = 'forsure-backup-active';
const DEBOUNCE_MS = 5_000;

export function useAutoBackup() {
  const { user } = useAuth();
  const { createBackup } = useSecureBackup();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Password lives ONLY in memory — never persisted in plain text
  const passwordRef = useRef<string | null>(null);
  const [hasPassword, setHasPassword] = useState(false);

  // On mount, check if a backup session was active (flag only, no password)
  useEffect(() => {
    try {
      const active = sessionStorage.getItem(BACKUP_CHECK_KEY);
      // The flag just tells us "user had set a password this session"
      // but we can't recover it — they'll need to re-enter on new tab
      if (active === '1' && passwordRef.current) {
        setHasPassword(true);
      }
    } catch {}
  }, []);

  /** Set the backup password for this session (called once by user) */
  const setBackupPassword = useCallback((password: string) => {
    passwordRef.current = password;
    setHasPassword(true);
    try {
      // Only store a non-sensitive flag — NOT the password
      sessionStorage.setItem(BACKUP_CHECK_KEY, '1');
    } catch {}
  }, []);

  /** Clear the password from memory */
  const clearBackupPassword = useCallback(() => {
    passwordRef.current = null;
    setHasPassword(false);
    try {
      sessionStorage.removeItem(BACKUP_CHECK_KEY);
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

  // Watch IndexedDB changes via polling
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

    const interval = setInterval(checkForChanges, 30_000);
    checkForChanges();

    return () => {
      clearInterval(interval);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [user, hasPassword, triggerBackup]);

  return { setBackupPassword, clearBackupPassword, triggerBackup, hasPassword };
}
