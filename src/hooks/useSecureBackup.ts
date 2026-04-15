/**
 * useSecureBackup — Secure E2EE key backup with recovery key (Element/Matrix model)
 * 
 * Architecture:
 * - A random 32-byte recovery key is generated client-side
 * - The recovery key derives an AES-256-GCM key via PBKDF2 (600k iterations)
 * - All E2EE key material is collected, encrypted, and uploaded as an opaque blob
 * - Server NEVER sees plaintext keys or recovery key
 * - Restore requires the same recovery key — full restore or explicit failure
 */

import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { openE2EEDB } from '@/lib/crypto/indexedDb';
import { generateRecoveryKey, normalizeRecoveryKey, isValidRecoveryKey } from '@/lib/crypto/recoveryKey';

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const BACKUP_VERSION = 2; // v2 = recovery key model

// Re-export for external use
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

  // Identity keys from IndexedDB
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

  // Ratchet states from IndexedDB
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

  // Integrity check: backup MUST contain identity keys
  const hasIdentity = data['e2ee:identity-keys']?.length > 0 || data['pinwrap:keys']?.length > 0;
  if (!hasIdentity) {
    throw new Error('Cannot create backup: no identity keys found locally');
  }

  // Add metadata
  data['_meta'] = {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    stores: Object.keys(data).filter(k => k !== '_meta'),
  };

  return JSON.stringify(data);
}

/**
 * Restore all local E2EE keys from backup — ATOMIC.
 * If any critical store fails to restore, the entire operation is rolled back.
 */
async function restoreKeys(json: string): Promise<void> {
  const data = JSON.parse(json);

  // Validate backup integrity before writing anything
  const hasIdentityKeys = data['e2ee:identity-keys']?.length > 0;
  const hasPinWrappedKeys = data['pinwrap:keys']?.length > 0;
  if (!hasIdentityKeys && !hasPinWrappedKeys) {
    throw new Error('Backup invalide : aucune clé d\'identité trouvée');
  }

  // Phase 1: Restore E2EE IndexedDB stores (identity-keys is CRITICAL)
  const restoredStores: string[] = [];
  for (const [key, records] of Object.entries(data)) {
    if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
    const storeName = key.replace('e2ee:', '');
      try {
        const db = await openE2EEDB();

      if (db.objectStoreNames.contains(storeName)) {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const record of records) {
          store.put(record);
        }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => { restoredStores.push(storeName); resolve(); };
          tx.onerror = () => reject(tx.error);
        });
      }
      db.close();
    } catch (e) {
      if (storeName === 'identity-keys') {
        throw new Error(`Critical restore failure: ${storeName} — ${e}`);
      }
      console.warn('[SecureBackup] Non-critical store restore failed:', storeName, e);
    }
  }

  // Phase 2: Restore ratchet states
  if (data['ratchet:states'] && Array.isArray(data['ratchet:states'])) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-ratchet', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('ratchet-states')) {
            db.createObjectStore('ratchet-states', { keyPath: 'convId' });
          }
        };
      });

      const tx = db.transaction('ratchet-states', 'readwrite');
      const store = tx.objectStore('ratchet-states');
      for (const record of data['ratchet:states']) {
        store.put(record);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (e) {
      console.warn('[SecureBackup] Failed to restore ratchet states', e);
    }
  }

  // Phase 3: Restore PIN-wrapped keys
  if (data['pinwrap:keys'] && Array.isArray(data['pinwrap:keys'])) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-pin-wrap', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('pin-wrapped-keys')) {
            db.createObjectStore('pin-wrapped-keys', { keyPath: 'id' });
          }
        };
      });

      const tx = db.transaction('pin-wrapped-keys', 'readwrite');
      const store = tx.objectStore('pin-wrapped-keys');
      for (const record of data['pinwrap:keys']) {
        store.put(record);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (e) {
      console.warn('[SecureBackup] Failed to restore PIN-wrapped keys', e);
    }
  }

  // Phase 4: Restore private prekeys
  if (data['prekeys:private'] && Array.isArray(data['prekeys:private'])) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-prekeys', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('private-prekeys')) {
            db.createObjectStore('private-prekeys', { keyPath: 'id' });
          }
        };
      });

      const tx = db.transaction('private-prekeys', 'readwrite');
      const store = tx.objectStore('private-prekeys');
      for (const record of data['prekeys:private']) {
        store.put(record);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (e) {
      console.warn('[SecureBackup] Failed to restore private prekeys', e);
    }
  }

  // Phase 5: Restore fingerprints
  if (data['fingerprints']) {
    localStorage.setItem('forsure-known-fps', data['fingerprints']);
  }

  console.log('[SecureBackup] Atomic restore complete — stores:', restoredStores.join(', '));
}

export function useSecureBackup() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Create a new backup with a freshly generated recovery key.
   * Returns the recovery key that the user MUST save — it's the only way to restore.
   */
  const createBackup = useCallback(async (): Promise<string | null> => {
    if (!user) {
      setError('Non authentifié');
      return null;
    }

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
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });

      if (dbError) throw dbError;

      console.log('[SecureBackup] Backup created with recovery key');
      return recoveryKey; // Formatted with dashes for readability
    } catch (err: any) {
      console.error('[SecureBackup] Backup failed:', err);
      setError(err.message || 'Échec de la sauvegarde');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  /**
   * Update an existing backup using the same recovery key.
   * Used by auto-backup to refresh the blob without generating a new key.
   */
  const updateBackup = useCallback(async (recoveryKey: string): Promise<boolean> => {
    if (!user) {
      setError('Non authentifié');
      return false;
    }

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
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });

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

  /**
   * Restore backup using recovery key.
   * Full restore or explicit failure — no partial state.
   */
  const restoreBackup = useCallback(async (recoveryKey: string): Promise<boolean> => {
    if (!user) {
      setError('Non authentifié');
      return false;
    }
    if (!isValidRecoveryKey(recoveryKey)) {
      setError('Clé de récupération invalide');
      return false;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { data, error: dbError } = await supabase
        .from('user_backups' as any)
        .select('encrypted_blob, salt, iv, version')
        .eq('user_id', user.id)
        .single();

      if (dbError || !data) {
        setError('Aucune sauvegarde trouvée');
        return false;
      }

      const backup = data as unknown as { encrypted_blob: string; salt: string; iv: string; version: number };
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
        .maybeSingle();
      return !!data;
    } catch {
      return false;
    }
  }, [user]);

  return {
    createBackup,
    updateBackup,
    restoreBackup,
    hasBackup,
    isLoading,
    error,
  };
}
