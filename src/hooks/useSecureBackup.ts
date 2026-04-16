/**
 * useSecureBackup — Secure E2EE key backup with recovery key (Element/Matrix model)
 * 
 * Architecture:
 * - A random 32-byte recovery key is generated client-side
 * - The recovery key derives an AES-256-GCM key via PBKDF2 (600k iterations)
 * - All E2EE key material is collected, encrypted, and uploaded as an opaque blob
 * - Server NEVER sees plaintext keys or recovery key
 * - Restore requires the same recovery key — full restore or explicit failure
 * 
 * v2: Uses backup_type='recovery' to avoid collision with account-based backup
 */

import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { openE2EEDB } from '@/lib/crypto/indexedDb';
import { generateRecoveryKey, normalizeRecoveryKey, isValidRecoveryKey } from '@/lib/crypto/recoveryKey';

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const BACKUP_VERSION = 2;
const BACKUP_TYPE = 'recovery';

export { generateRecoveryKey, normalizeRecoveryKey, isValidRecoveryKey };

async function deriveKey(recoveryKey: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(recoveryKey),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptBlob(data: string, recoveryKey: string): Promise<{ encrypted: string; salt: string; iv: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(recoveryKey, salt);
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    encrypted: bufferToBase64(ciphertext),
    salt: bufferToBase64(salt.buffer),
    iv: bufferToBase64(iv.buffer),
  };
}

async function decryptBlob(encrypted: string, salt: string, iv: string, recoveryKey: string): Promise<string> {
  const saltBuf = new Uint8Array(base64ToBuffer(salt));
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const key = await deriveKey(recoveryKey, saltBuf);
  const ciphertext = base64ToBuffer(encrypted);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

/** Collect all local E2EE keys for backup — COMPLETE snapshot */
async function collectKeys(): Promise<string> {
  const data: Record<string, any> = {};

  try {
    const db = await openE2EEDB();
    for (const storeName of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const all = await new Promise<any[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      data[`e2ee:${storeName}`] = all;
    }
    db.close();
  } catch {}

  // Ratchet states
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-ratchet', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    if (db.objectStoreNames.contains('ratchet-states')) {
      const tx = db.transaction('ratchet-states', 'readonly');
      const all = await new Promise<any[]>((resolve, reject) => {
        const req = tx.objectStore('ratchet-states').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      data['ratchet:states'] = all;
    }
    db.close();
  } catch {}

  // PIN-wrapped keys
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-pin-wrap', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    if (db.objectStoreNames.contains('pin-wrapped-keys')) {
      const tx = db.transaction('pin-wrapped-keys', 'readonly');
      const all = await new Promise<any[]>((resolve, reject) => {
        const req = tx.objectStore('pin-wrapped-keys').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      data['pinwrap:keys'] = all;
    }
    db.close();
  } catch {}

  // Private prekeys
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-prekeys', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    if (db.objectStoreNames.contains('private-prekeys')) {
      const tx = db.transaction('private-prekeys', 'readonly');
      const all = await new Promise<any[]>((resolve, reject) => {
        const req = tx.objectStore('private-prekeys').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      data['prekeys:private'] = all;
    }
    db.close();
  } catch {}

  // Known fingerprints
  try {
    const fps = localStorage.getItem('forsure-known-fps');
    if (fps) data['fingerprints'] = fps;
  } catch {}

  // Integrity check
  const hasIdentity = data['e2ee:identity-keys']?.length > 0 || data['pinwrap:keys']?.length > 0;
  if (!hasIdentity) {
    throw new Error('Cannot create backup: no identity keys found locally');
  }

  data['_meta'] = {
    version: BACKUP_VERSION,
    backup_type: BACKUP_TYPE,
    createdAt: new Date().toISOString(),
    stores: Object.keys(data).filter(k => k !== '_meta'),
  };

  return JSON.stringify(data);
}

/**
 * Restore all local E2EE keys from backup — TRULY ATOMIC.
 * If ANY store fails to restore, ALL changes are rolled back.
 */
async function restoreKeys(json: string): Promise<void> {
  const data = JSON.parse(json);

  const hasIdentityKeys = data['e2ee:identity-keys']?.length > 0;
  const hasPinWrappedKeys = data['pinwrap:keys']?.length > 0;
  if (!hasIdentityKeys && !hasPinWrappedKeys) {
    throw new Error('Backup invalide : aucune clé d\'identité trouvée');
  }

  const rollbackOps: Array<() => Promise<void>> = [];

  try {
    // Phase 1: Restore E2EE IndexedDB stores
    for (const [key, records] of Object.entries(data)) {
      if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
      const storeName = key.replace('e2ee:', '');
      const db = await openE2EEDB();
      if (db.objectStoreNames.contains(storeName)) {
        // Save existing for rollback
        const existingTx = db.transaction(storeName, 'readonly');
        const existingData = await new Promise<any[]>((resolve, reject) => {
          const req = existingTx.objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });

        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.clear();
        for (const record of records) store.put(record);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });

        const sn = storeName;
        const ed = existingData;
        rollbackOps.push(async () => {
          const rdb = await openE2EEDB();
          if (rdb.objectStoreNames.contains(sn)) {
            const rtx = rdb.transaction(sn, 'readwrite');
            const rs = rtx.objectStore(sn);
            rs.clear();
            for (const r of ed) rs.put(r);
            await new Promise<void>((r, j) => { rtx.oncomplete = () => r(); rtx.onerror = () => j(rtx.error); });
          }
          rdb.close();
        });
      }
      db.close();
    }

    // Phase 2: Restore ratchet states
    if (data['ratchet:states'] && Array.isArray(data['ratchet:states'])) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-ratchet', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('ratchet-states'))
            req.result.createObjectStore('ratchet-states', { keyPath: 'convId' });
        };
      });
      const existingTx = db.transaction('ratchet-states', 'readonly');
      const existingData = await new Promise<any[]>((r, j) => {
        const req = existingTx.objectStore('ratchet-states').getAll();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });

      const tx = db.transaction('ratchet-states', 'readwrite');
      const store = tx.objectStore('ratchet-states');
      store.clear();
      for (const record of data['ratchet:states']) store.put(record);
      await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
      db.close();

      rollbackOps.push(async () => {
        const rdb = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('forsure-ratchet', 1);
          req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result);
        });
        const rtx = rdb.transaction('ratchet-states', 'readwrite');
        rtx.objectStore('ratchet-states').clear();
        for (const r of existingData) rtx.objectStore('ratchet-states').put(r);
        await new Promise<void>((r, j) => { rtx.oncomplete = () => r(); rtx.onerror = () => j(rtx.error); });
        rdb.close();
      });
    }

    // Phase 3: Restore PIN-wrapped keys
    if (data['pinwrap:keys'] && Array.isArray(data['pinwrap:keys'])) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-pin-wrap', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('pin-wrapped-keys'))
            req.result.createObjectStore('pin-wrapped-keys', { keyPath: 'id' });
        };
      });
      const existingTx = db.transaction('pin-wrapped-keys', 'readonly');
      const existingData = await new Promise<any[]>((r, j) => {
        const req = existingTx.objectStore('pin-wrapped-keys').getAll();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });

      const tx = db.transaction('pin-wrapped-keys', 'readwrite');
      const store = tx.objectStore('pin-wrapped-keys');
      store.clear();
      for (const record of data['pinwrap:keys']) store.put(record);
      await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
      db.close();

      rollbackOps.push(async () => {
        const rdb = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('forsure-pin-wrap', 1);
          req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result);
        });
        const rtx = rdb.transaction('pin-wrapped-keys', 'readwrite');
        rtx.objectStore('pin-wrapped-keys').clear();
        for (const r of existingData) rtx.objectStore('pin-wrapped-keys').put(r);
        await new Promise<void>((r, j) => { rtx.oncomplete = () => r(); rtx.onerror = () => j(rtx.error); });
        rdb.close();
      });
    }

    // Phase 4: Restore private prekeys
    if (data['prekeys:private'] && Array.isArray(data['prekeys:private'])) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-prekeys', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('private-prekeys'))
            req.result.createObjectStore('private-prekeys', { keyPath: 'id' });
        };
      });
      const existingTx = db.transaction('private-prekeys', 'readonly');
      const existingData = await new Promise<any[]>((r, j) => {
        const req = existingTx.objectStore('private-prekeys').getAll();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });

      const tx = db.transaction('private-prekeys', 'readwrite');
      const store = tx.objectStore('private-prekeys');
      store.clear();
      for (const record of data['prekeys:private']) store.put(record);
      await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
      db.close();

      rollbackOps.push(async () => {
        const rdb = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('forsure-prekeys', 1);
          req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result);
        });
        const rtx = rdb.transaction('private-prekeys', 'readwrite');
        rtx.objectStore('private-prekeys').clear();
        for (const r of existingData) rtx.objectStore('private-prekeys').put(r);
        await new Promise<void>((r, j) => { rtx.oncomplete = () => r(); rtx.onerror = () => j(rtx.error); });
        rdb.close();
      });
    }

    // Phase 5: Restore fingerprints
    if (data['fingerprints']) {
      const oldFps = localStorage.getItem('forsure-known-fps');
      localStorage.setItem('forsure-known-fps', data['fingerprints']);
      rollbackOps.push(async () => {
        if (oldFps) localStorage.setItem('forsure-known-fps', oldFps);
        else localStorage.removeItem('forsure-known-fps');
      });
    }

    console.log('[SecureBackup] ✅ Atomic restore complete');
  } catch (error) {
    console.error('[SecureBackup] Restore failed, rolling back ALL changes...', error);
    for (const rollback of rollbackOps.reverse()) {
      try { await rollback(); } catch (e) { console.warn('[SecureBackup] Rollback step failed:', e); }
    }
    throw new Error(`Restore échoué et annulé : ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function useSecureBackup() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createBackup = useCallback(async (): Promise<string | null> => {
    if (!user) { setError('Non authentifié'); return null; }
    setIsLoading(true);
    setError(null);
    try {
      const keysJson = await collectKeys();
      const recoveryKey = generateRecoveryKey();
      const normalized = normalizeRecoveryKey(recoveryKey);
      const { encrypted, salt, iv } = await encryptBlob(keysJson, normalized);

      const { error: dbError } = await supabase
        .from('user_backups' as any)
        .upsert({
          user_id: user.id,
          encrypted_blob: encrypted,
          salt,
          iv,
          version: BACKUP_VERSION,
          backup_type: BACKUP_TYPE,
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id,backup_type' });

      if (dbError) throw dbError;
      console.log('[SecureBackup] Backup created with recovery key');
      return recoveryKey;
    } catch (err: any) {
      console.error('[SecureBackup] Backup failed:', err);
      setError(err.message || 'Échec de la sauvegarde');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const updateBackup = useCallback(async (recoveryKey: string): Promise<boolean> => {
    if (!user) { setError('Non authentifié'); return false; }
    setIsLoading(true);
    setError(null);
    try {
      const keysJson = await collectKeys();
      const normalized = normalizeRecoveryKey(recoveryKey);
      const { encrypted, salt, iv } = await encryptBlob(keysJson, normalized);

      const { error: dbError } = await supabase
        .from('user_backups' as any)
        .upsert({
          user_id: user.id,
          encrypted_blob: encrypted,
          salt,
          iv,
          version: BACKUP_VERSION,
          backup_type: BACKUP_TYPE,
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id,backup_type' });

      if (dbError) throw dbError;
      console.log('[SecureBackup] Backup updated');
      return true;
    } catch (err: any) {
      console.error('[SecureBackup] Update failed:', err);
      setError(err.message || 'Échec de la mise à jour');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const restoreBackup = useCallback(async (recoveryKey: string): Promise<boolean> => {
    if (!user) { setError('Non authentifié'); return false; }
    if (!isValidRecoveryKey(recoveryKey)) { setError('Clé de récupération invalide'); return false; }
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: dbError } = await supabase
        .from('user_backups' as any)
        .select('encrypted_blob, salt, iv, version, backup_type')
        .eq('user_id', user.id)
        .eq('backup_type', BACKUP_TYPE)
        .single();

      if (dbError || !data) { setError('Aucune sauvegarde de type recovery trouvée'); return false; }

      const backup = data as unknown as { encrypted_blob: string; salt: string; iv: string; version: number; backup_type: string };

      // Version guard: refuse account-based backup format
      if (backup.version >= 3 && backup.backup_type !== BACKUP_TYPE) {
        setError('Format de sauvegarde incompatible (backup compte détecté)');
        return false;
      }

      const normalized = normalizeRecoveryKey(recoveryKey);
      const keysJson = await decryptBlob(backup.encrypted_blob, backup.salt, backup.iv, normalized);
      await restoreKeys(keysJson);
      console.log('[SecureBackup] Full restore completed successfully');
      return true;
    } catch (err: any) {
      console.error('[SecureBackup] Restore failed:', err);
      if (err.name === 'OperationError') {
        setError('Clé de récupération incorrecte');
      } else {
        setError(err.message || 'Échec de la restauration');
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const hasBackup = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    try {
      const { data } = await supabase
        .from('user_backups' as any)
        .select('id')
        .eq('user_id', user.id)
        .eq('backup_type', BACKUP_TYPE)
        .maybeSingle();
      return !!data;
    } catch {
      return false;
    }
  }, [user]);

  return { createBackup, updateBackup, restoreBackup, hasBackup, isLoading, error };
}
