/**
 * useDeviceLink — QR-based device-to-device E2EE key transfer
 *
 * Flow:
 * 1. Source device: createLink() → generates QR containing token + password
 * 2. Source device: auto-collects keys, encrypts with password, uploads
 * 3. New device: claimLink(token, password) → downloads + decrypts keys
 */

import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';

const PBKDF2_ITERATIONS = 600_000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
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

/** Collect all E2EE keys from local storage */
async function collectLocalKeys(): Promise<string> {
  const data: Record<string, any> = {};

  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-e2ee', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    for (const storeName of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(storeName, 'readonly');
      const all = await new Promise<any[]>((resolve, reject) => {
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      data[`e2ee:${storeName}`] = all;
    }
    db.close();
  } catch {}

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

  try {
    const fps = localStorage.getItem('forsure-known-fps');
    if (fps) data['fingerprints'] = fps;
  } catch {}

  return JSON.stringify(data);
}

/** Restore keys from JSON into local stores */
async function restoreLocalKeys(json: string): Promise<void> {
  const data = JSON.parse(json);

  for (const [key, records] of Object.entries(data)) {
    if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
    const storeName = key.replace('e2ee:', '');
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-e2ee', 2);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(storeName)) {
            req.result.createObjectStore(storeName, { keyPath: 'id' });
          }
        };
      });
      if (db.objectStoreNames.contains(storeName)) {
        const tx = db.transaction(storeName, 'readwrite');
        for (const record of records) tx.objectStore(storeName).put(record);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      db.close();
    } catch {}
  }

  if (data['ratchet:states'] && Array.isArray(data['ratchet:states'])) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-ratchet', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('ratchet-states')) {
            req.result.createObjectStore('ratchet-states', { keyPath: 'convId' });
          }
        };
      });
      const tx = db.transaction('ratchet-states', 'readwrite');
      for (const r of data['ratchet:states']) tx.objectStore('ratchet-states').put(r);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
  }

  if (data['fingerprints']) {
    localStorage.setItem('forsure-known-fps', data['fingerprints']);
  }
}

export function useDeviceLink() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Creates a device link from the source device.
   * Returns { qrData } containing the token + password to encode in a QR.
   */
  const createLink = useCallback(async (): Promise<{ qrData: string } | null> => {
    if (!user) { setError('Non authentifié'); return null; }
    setIsLoading(true);
    setError(null);

    try {
      // 1. Ask server to create a link token
      const { data: tokenData, error: fnError } = await supabase.functions.invoke(
        'device-link',
        { body: { action: 'create' } }
      );
      if (fnError) throw fnError;

      const token = tokenData.token as string;

      // 2. Generate a one-time password for encryption
      const pwdBytes = crypto.getRandomValues(new Uint8Array(24));
      const password = btoa(String.fromCharCode(...pwdBytes));

      // 3. Collect + encrypt keys
      const keysJson = await collectLocalKeys();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(password, salt);
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(keysJson),
      );

      const payload = JSON.stringify({
        ct: bufferToBase64(ciphertext),
        salt: bufferToBase64(salt.buffer),
        iv: bufferToBase64(iv.buffer),
      });

      // 4. Upload encrypted payload
      const { error: uploadError } = await supabase.functions.invoke(
        'device-link',
        { body: { action: 'upload', encrypted_payload: payload } }
      );
      if (uploadError) throw uploadError;

      // 5. Return QR data (token + password)
      const qrData = JSON.stringify({ t: token, p: password });
      return { qrData };
    } catch (err: any) {
      setError(err.message || 'Erreur de liaison');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  /**
   * Claims keys on the new device using data scanned from QR.
   */
  const claimLink = useCallback(async (qrData: string): Promise<boolean> => {
    if (!user) { setError('Non authentifié'); return false; }
    setIsLoading(true);
    setError(null);

    try {
      const { t: token, p: password } = JSON.parse(qrData);

      // 1. Claim from server
      const { data: claimData, error: claimError } = await supabase.functions.invoke(
        'device-link',
        { body: { action: 'claim', token } }
      );
      if (claimError) throw claimError;

      // 2. Decrypt payload
      const envelope = JSON.parse(claimData.encrypted_payload);
      const salt = new Uint8Array(base64ToBuffer(envelope.salt));
      const iv = new Uint8Array(base64ToBuffer(envelope.iv));
      const ct = base64ToBuffer(envelope.ct);
      const key = await deriveKey(password, salt);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      const keysJson = new TextDecoder().decode(plainBuf);

      // 3. Restore keys locally
      await restoreLocalKeys(keysJson);

      console.log('[DeviceLink] Keys restored successfully');
      return true;
    } catch (err: any) {
      if (err.name === 'OperationError') {
        setError('QR code invalide ou expiré');
      } else {
        setError(err.message || 'Erreur de récupération');
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  return { createLink, claimLink, isLoading, error };
}
