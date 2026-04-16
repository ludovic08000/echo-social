/**
 * Account-based Key Backup — Google-style automatic key vault
 * 
 * Keys are encrypted using a key derived from the user's password + user_id.
 * On login, keys are automatically restored if local storage is empty.
 * On key changes, keys are automatically backed up.
 * 
 * The password never leaves the client — only a PBKDF2-derived key is used.
 */

import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { openE2EEDB } from '@/lib/crypto/indexedDb';
import { supabase } from '@/integrations/supabase/client';

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const BACKUP_VERSION = 3; // v3 = account-based auto-backup

// Volatile in-memory storage for the derived key — never persisted
let _sessionDerivedKey: CryptoKey | null = null;
let _sessionUserId: string | null = null;

/**
 * Derive an AES-256-GCM key from password + userId.
 * The userId acts as a static salt component to bind the key to the account.
 */
async function deriveKeyFromPassword(password: string, userId: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  // Combine password + userId for account binding
  const combined = `${password}::forsure::${userId}`;
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(combined),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Generate a stable salt from userId (deterministic so we can re-derive on login).
 * We store a random salt in the backup itself for the encryption,
 * but we need a way to re-derive the same wrapping key from just password+userId.
 */
async function getStableSalt(userId: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(`forsure-backup-salt::${userId}`));
  return new Uint8Array(hash);
}

async function encryptWithDerivedKey(data: string, key: CryptoKey): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    encrypted: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
  };
}

async function decryptWithDerivedKey(encrypted: string, iv: string, key: CryptoKey): Promise<string> {
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const ciphertext = base64ToBuffer(encrypted);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

/** Collect all local E2EE keys for backup */
async function collectAllKeys(): Promise<string | null> {
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

  // Fingerprints
  try {
    const fps = localStorage.getItem('forsure-known-fps');
    if (fps) data['fingerprints'] = fps;
  } catch {}

  // Check if there's anything worth backing up
  const hasIdentity = data['e2ee:identity-keys']?.length > 0 || data['pinwrap:keys']?.length > 0;
  if (!hasIdentity) return null;

  data['_meta'] = {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    stores: Object.keys(data).filter(k => k !== '_meta'),
  };

  return JSON.stringify(data);
}

/** Restore all local E2EE keys from backup JSON */
async function restoreAllKeys(json: string): Promise<void> {
  const data = JSON.parse(json);

  const hasIdentityKeys = data['e2ee:identity-keys']?.length > 0;
  const hasPinWrappedKeys = data['pinwrap:keys']?.length > 0;
  if (!hasIdentityKeys && !hasPinWrappedKeys) {
    throw new Error('Backup invalide : aucune clé d\'identité');
  }

  // Restore E2EE stores
  for (const [key, records] of Object.entries(data)) {
    if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
    const storeName = key.replace('e2ee:', '');
    try {
      const db = await openE2EEDB();
      if (db.objectStoreNames.contains(storeName)) {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const record of records) store.put(record);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      db.close();
    } catch (e) {
      if (storeName === 'identity-keys') throw e;
    }
  }

  // Restore ratchet states
  if (Array.isArray(data['ratchet:states'])) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-ratchet', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('ratchet-states'))
            req.result.createObjectStore('ratchet-states', { keyPath: 'convId' });
        };
      });
      const tx = db.transaction('ratchet-states', 'readwrite');
      for (const r of data['ratchet:states']) tx.objectStore('ratchet-states').put(r);
      await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
      db.close();
    } catch {}
  }

  // Restore PIN-wrapped keys
  if (Array.isArray(data['pinwrap:keys'])) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-pin-wrap', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('pin-wrapped-keys'))
            req.result.createObjectStore('pin-wrapped-keys', { keyPath: 'id' });
        };
      });
      const tx = db.transaction('pin-wrapped-keys', 'readwrite');
      for (const r of data['pinwrap:keys']) tx.objectStore('pin-wrapped-keys').put(r);
      await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
      db.close();
    } catch {}
  }

  // Restore private prekeys
  if (Array.isArray(data['prekeys:private'])) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('forsure-prekeys', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('private-prekeys'))
            req.result.createObjectStore('private-prekeys', { keyPath: 'id' });
        };
      });
      const tx = db.transaction('private-prekeys', 'readwrite');
      for (const r of data['prekeys:private']) tx.objectStore('private-prekeys').put(r);
      await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
      db.close();
    } catch {}
  }

  // Restore fingerprints
  if (data['fingerprints']) {
    localStorage.setItem('forsure-known-fps', data['fingerprints']);
  }
}

/** Check if local E2EE keys exist */
export async function hasLocalKeys(): Promise<boolean> {
  try {
    const db = await openE2EEDB();
    let count = 0;
    if (db.objectStoreNames.contains('identity-keys')) {
      const tx = db.transaction('identity-keys', 'readonly');
      count = await new Promise<number>((resolve, reject) => {
        const req = tx.objectStore('identity-keys').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    db.close();
    return count > 0;
  } catch {
    return false;
  }
}

// ── Public API ──

/**
 * Called at login time with the user's password.
 * Derives the backup key and stores it in memory for the session.
 * Then checks if local keys exist — if not, auto-restores from server.
 */
export async function initAccountKeySync(password: string, userId: string): Promise<'restored' | 'local_ok' | 'no_backup' | 'error'> {
  try {
    const salt = await getStableSalt(userId);
    _sessionDerivedKey = await deriveKeyFromPassword(password, userId, salt);
    _sessionUserId = userId;

    // Check local keys
    const hasLocal = await hasLocalKeys();
    if (hasLocal) {
      console.log('[AccountKeySync] Local keys present, syncing backup...');
      // Auto-backup current state
      syncBackupToServer().catch(() => {});
      return 'local_ok';
    }

    // No local keys — try to restore from server
    console.log('[AccountKeySync] No local keys, attempting restore...');
    const { data } = await supabase
      .from('user_backups' as any)
      .select('encrypted_blob, iv, version')
      .eq('user_id', userId)
      .maybeSingle();

    if (!data) {
      console.log('[AccountKeySync] No server backup found');
      return 'no_backup';
    }

    const backup = data as unknown as { encrypted_blob: string; iv: string; version: number };
    
    try {
      const json = await decryptWithDerivedKey(backup.encrypted_blob, backup.iv, _sessionDerivedKey);
      await restoreAllKeys(json);
      console.log('[AccountKeySync] ✅ Keys auto-restored from server');
      return 'restored';
    } catch (decryptErr) {
      console.warn('[AccountKeySync] Decrypt failed (password may have changed)', decryptErr);
      return 'error';
    }
  } catch (err) {
    console.error('[AccountKeySync] Init failed:', err);
    return 'error';
  }
}

/**
 * Encrypt current keys and upload to server.
 * Called automatically after key changes.
 */
export async function syncBackupToServer(): Promise<boolean> {
  if (!_sessionDerivedKey || !_sessionUserId) return false;

  try {
    const keysJson = await collectAllKeys();
    if (!keysJson) return false;

    const { encrypted, iv } = await encryptWithDerivedKey(keysJson, _sessionDerivedKey);

    const { error } = await supabase
      .from('user_backups' as any)
      .upsert({
        user_id: _sessionUserId,
        encrypted_blob: encrypted,
        salt: '', // Not needed for account-based backup (salt is deterministic)
        iv,
        version: BACKUP_VERSION,
        created_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (error) throw error;
    console.log('[AccountKeySync] ✅ Backup synced to server');
    return true;
  } catch (err) {
    console.warn('[AccountKeySync] Sync failed:', err);
    return false;
  }
}

/** Check if auto-backup session is active */
export function isAutoBackupActive(): boolean {
  return _sessionDerivedKey !== null;
}

/** Clear session key (on logout) */
export function clearAccountKeySession(): void {
  _sessionDerivedKey = null;
  _sessionUserId = null;
}
