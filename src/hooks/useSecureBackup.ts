/**
 * useSecureBackup — Secure key backup system (WhatsApp-style)
 * 
 * - Keys are encrypted locally with PBKDF2 + AES-256-GCM before upload
 * - Server NEVER sees the plaintext keys or password
 * - Restore requires the same password used during backup
 */

import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const BACKUP_VERSION = 1;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptBlob(data: string, password: string): Promise<{ encrypted: string; salt: string; iv: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    encrypted: bufferToBase64(ciphertext),
    salt: bufferToBase64(salt.buffer),
    iv: bufferToBase64(iv.buffer),
  };
}

async function decryptBlob(encrypted: string, salt: string, iv: string, password: string): Promise<string> {
  const saltBuf = new Uint8Array(base64ToBuffer(salt));
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const key = await deriveKey(password, saltBuf);
  const ciphertext = base64ToBuffer(encrypted);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

/** Collect all local E2EE keys for backup */
async function collectKeys(): Promise<string> {
  const data: Record<string, any> = {};

  // Identity keys from IndexedDB
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-e2ee', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });

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

  // Known fingerprints
  try {
    const fps = localStorage.getItem('forsure-known-fps');
    if (fps) data['fingerprints'] = fps;
  } catch {}

  return JSON.stringify(data);
}

/** Restore all local E2EE keys from backup */
async function restoreKeys(json: string): Promise<void> {
  const data = JSON.parse(json);

  // Restore E2EE IndexedDB stores
  for (const [key, records] of Object.entries(data)) {
    if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
    const storeName = key.replace('e2ee:', '');
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-e2ee', 2);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'id' });
          }
        };
      });

      if (db.objectStoreNames.contains(storeName)) {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const record of records) {
          store.put(record);
        }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      db.close();
    } catch (e) {
      console.warn('[SecureBackup] Failed to restore store', storeName, e);
    }
  }

  // Restore ratchet states
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

  // Restore fingerprints
  if (data['fingerprints']) {
    localStorage.setItem('forsure-known-fps', data['fingerprints']);
  }
}

export function useSecureBackup() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createBackup = useCallback(async (password: string): Promise<boolean> => {
    if (!user) {
      setError('Non authentifié');
      return false;
    }
    if (password.length < 8) {
      setError('Le mot de passe doit faire au moins 8 caractères');
      return false;
    }

    setIsLoading(true);
    setError(null);

    try {
      const keysJson = await collectKeys();
      const { encrypted, salt, iv } = await encryptBlob(keysJson, password);

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

      console.log('[SecureBackup] Backup created successfully');
      return true;
    } catch (err: any) {
      console.error('[SecureBackup] Backup failed:', err);
      setError(err.message || 'Échec de la sauvegarde');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const restoreBackup = useCallback(async (password: string): Promise<boolean> => {
    if (!user) {
      setError('Non authentifié');
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

      const backup = data as { encrypted_blob: string; salt: string; iv: string; version: number };
      const keysJson = await decryptBlob(backup.encrypted_blob, backup.salt, backup.iv, password);
      await restoreKeys(keysJson);

      console.log('[SecureBackup] Restore completed successfully');
      return true;
    } catch (err: any) {
      console.error('[SecureBackup] Restore failed:', err);
      if (err.name === 'OperationError') {
        setError('Mot de passe incorrect');
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
    restoreBackup,
    hasBackup,
    isLoading,
    error,
  };
}
