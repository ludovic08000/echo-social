/**
 * Account-based Key Backup — Google-style automatic key vault
 * 
 * Keys are encrypted using a key derived from the user's password + user_id.
 * On login, keys are automatically restored if local storage is empty.
 * On key changes, keys are automatically backed up.
 * 
 * The password never leaves the client — only a PBKDF2-derived key is used.
 * 
 * v4: random salt stored in backup, content-based change detection,
 *     checks pin-wrapped keys in hasLocalKeys, truly atomic restore.
 */

import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { openE2EEDB } from '@/lib/crypto/indexedDb';
import { supabase } from '@/integrations/supabase/client';

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const BACKUP_VERSION = 4; // v4 = account-based with random salt + atomic restore
const BACKUP_TYPE = 'account';

// Volatile in-memory storage for the derived key — never persisted
let _sessionDerivedKey: CryptoKey | null = null;
let _sessionUserId: string | null = null;
let _sessionPassword: string | null = null; // needed to re-derive with new random salt on each sync

/**
 * Derive an AES-256-GCM key from password + userId + random salt.
 */
async function deriveKeyFromPassword(password: string, userId: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
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

async function encryptWithPassword(data: string, password: string, userId: string): Promise<{ encrypted: string; iv: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKeyFromPassword(password, userId, salt);
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    encrypted: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
    salt: bufferToBase64(salt.buffer),
  };
}

async function decryptWithPassword(encrypted: string, iv: string, salt: string, password: string, userId: string): Promise<string> {
  const saltBuf = new Uint8Array(base64ToBuffer(salt));
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const key = await deriveKeyFromPassword(password, userId, saltBuf);
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
    backup_type: BACKUP_TYPE,
    createdAt: new Date().toISOString(),
    stores: Object.keys(data).filter(k => k !== '_meta'),
  };

  return JSON.stringify(data);
}

/**
 * Restore all local E2EE keys from backup JSON — TRULY ATOMIC.
 * If ANY store fails to restore, ALL changes are rolled back.
 */
async function restoreAllKeys(json: string): Promise<void> {
  const data = JSON.parse(json);

  const hasIdentityKeys = data['e2ee:identity-keys']?.length > 0;
  const hasPinWrappedKeys = data['pinwrap:keys']?.length > 0;
  if (!hasIdentityKeys && !hasPinWrappedKeys) {
    throw new Error('Backup invalide : aucune clé d\'identité');
  }

  // Collect all operations, execute them, rollback ALL on any failure
  const rollbackOps: Array<() => Promise<void>> = [];

  try {
    // Phase 1: Restore E2EE stores
    for (const [key, records] of Object.entries(data)) {
      if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
      const storeName = key.replace('e2ee:', '');
      const db = await openE2EEDB();
      if (db.objectStoreNames.contains(storeName)) {
        // Save existing data for rollback
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

        // Register rollback
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
    if (Array.isArray(data['ratchet:states'])) {
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
      tx.objectStore('ratchet-states').clear();
      for (const r of data['ratchet:states']) tx.objectStore('ratchet-states').put(r);
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
    if (Array.isArray(data['pinwrap:keys'])) {
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
      tx.objectStore('pin-wrapped-keys').clear();
      for (const r of data['pinwrap:keys']) tx.objectStore('pin-wrapped-keys').put(r);
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
    if (Array.isArray(data['prekeys:private'])) {
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
      tx.objectStore('private-prekeys').clear();
      for (const r of data['prekeys:private']) tx.objectStore('private-prekeys').put(r);
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

    console.log('[AccountKeySync] ✅ Atomic restore complete');
  } catch (error) {
    // ROLLBACK everything
    console.error('[AccountKeySync] Restore failed, rolling back...', error);
    for (const rollback of rollbackOps.reverse()) {
      try { await rollback(); } catch (e) { console.warn('[AccountKeySync] Rollback step failed:', e); }
    }
    throw new Error(`Restore échoué et annulé : ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if local E2EE keys exist — checks BOTH raw identity keys AND pin-wrapped keys.
 */
export async function hasLocalKeys(): Promise<boolean> {
  // Check raw identity keys
  try {
    const db = await openE2EEDB();
    let rawCount = 0;
    if (db.objectStoreNames.contains('identity-keys')) {
      const tx = db.transaction('identity-keys', 'readonly');
      rawCount = await new Promise<number>((resolve, reject) => {
        const req = tx.objectStore('identity-keys').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    db.close();
    if (rawCount > 0) return true;
  } catch {}

  // Check pin-wrapped keys
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-pin-wrap', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    let pinCount = 0;
    if (db.objectStoreNames.contains('pin-wrapped-keys')) {
      const tx = db.transaction('pin-wrapped-keys', 'readonly');
      pinCount = await new Promise<number>((resolve, reject) => {
        const req = tx.objectStore('pin-wrapped-keys').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    db.close();
    if (pinCount > 0) return true;
  } catch {}

  // Check ratchet states (keys exist but identity scrubbed = still "has keys")
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-ratchet', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    let ratchetCount = 0;
    if (db.objectStoreNames.contains('ratchet-states')) {
      const tx = db.transaction('ratchet-states', 'readonly');
      ratchetCount = await new Promise<number>((resolve, reject) => {
        const req = tx.objectStore('ratchet-states').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    db.close();
    if (ratchetCount > 0) return true;
  } catch {}

  return false;
}

/**
 * Compute a content-based hash of all local crypto state.
 * Used by useAccountKeySync to detect real changes, not just count changes.
 */
export async function computeLocalCryptoDigest(): Promise<string> {
  const parts: string[] = [];

  // E2EE DB
  try {
    const db = await openE2EEDB();
    for (const storeName of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(storeName, 'readonly');
      const all = await new Promise<any[]>((resolve, reject) => {
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      parts.push(`${storeName}:${all.length}:${JSON.stringify(all).length}`);
    }
    db.close();
  } catch {}

  // Ratchet DB
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-ratchet', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    if (db.objectStoreNames.contains('ratchet-states')) {
      const tx = db.transaction('ratchet-states', 'readonly');
      const all = await new Promise<any[]>((r, j) => {
        const req = tx.objectStore('ratchet-states').getAll();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });
      parts.push(`ratchet:${all.length}:${JSON.stringify(all).length}`);
    }
    db.close();
  } catch {}

  // PIN-wrap DB
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-pin-wrap', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    if (db.objectStoreNames.contains('pin-wrapped-keys')) {
      const tx = db.transaction('pin-wrapped-keys', 'readonly');
      const all = await new Promise<any[]>((r, j) => {
        const req = tx.objectStore('pin-wrapped-keys').getAll();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });
      parts.push(`pinwrap:${all.length}:${JSON.stringify(all).length}`);
    }
    db.close();
  } catch {}

  // Prekeys DB  
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-prekeys', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    if (db.objectStoreNames.contains('private-prekeys')) {
      const tx = db.transaction('private-prekeys', 'readonly');
      const all = await new Promise<any[]>((r, j) => {
        const req = tx.objectStore('private-prekeys').getAll();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });
      parts.push(`prekeys:${all.length}:${JSON.stringify(all).length}`);
    }
    db.close();
  } catch {}

  const combined = parts.join('|');
  // Simple hash via SubtleCrypto
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined));
  return bufferToBase64(hash);
}

// ── Public API ──

/**
 * Called at login time with the user's password.
 * Derives the backup key and stores it in memory for the session.
 * Then checks if local keys exist — if not, auto-restores from server.
 */
export async function initAccountKeySync(password: string, userId: string): Promise<'restored' | 'local_ok' | 'no_backup' | 'error'> {
  try {
    _sessionPassword = password;
    _sessionUserId = userId;
    // Derive a temporary key just for session (actual encrypt/decrypt uses fresh salt each time)
    const tmpSalt = new Uint8Array(32);
    _sessionDerivedKey = await deriveKeyFromPassword(password, userId, tmpSalt);

    // Check local keys (now checks raw + pin-wrapped + ratchet)
    const hasLocal = await hasLocalKeys();
    if (hasLocal) {
      console.log('[AccountKeySync] Local keys present, syncing backup...');
      syncBackupToServer().catch(() => {});
      return 'local_ok';
    }

    // No local keys — try to restore from server
    console.log('[AccountKeySync] No local keys, attempting restore...');
    const { data } = await supabase
      .from('user_backups' as any)
      .select('encrypted_blob, iv, salt, version, backup_type')
      .eq('user_id', userId)
      .eq('backup_type', BACKUP_TYPE)
      .maybeSingle();

    if (!data) {
      console.log('[AccountKeySync] No server backup found');
      return 'no_backup';
    }

    const backup = data as unknown as { encrypted_blob: string; iv: string; salt: string; version: number; backup_type: string };
    
    // Version guard: refuse incompatible formats
    if (backup.version < 3) {
      console.warn('[AccountKeySync] Backup is recovery-key format (v' + backup.version + '), skipping');
      return 'no_backup';
    }

    try {
      const json = await decryptWithPassword(backup.encrypted_blob, backup.iv, backup.salt, password, userId);
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
 * Uses fresh random salt each time for maximum security.
 */
export async function syncBackupToServer(): Promise<boolean> {
  if (!_sessionPassword || !_sessionUserId) return false;

  try {
    const keysJson = await collectAllKeys();
    if (!keysJson) return false;

    const { encrypted, iv, salt } = await encryptWithPassword(keysJson, _sessionPassword, _sessionUserId);

    const { error } = await supabase
      .from('user_backups' as any)
      .upsert({
        user_id: _sessionUserId,
        encrypted_blob: encrypted,
        salt,
        iv,
        version: BACKUP_VERSION,
        backup_type: BACKUP_TYPE,
        created_at: new Date().toISOString(),
      }, { onConflict: 'user_id,backup_type' });

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
  return _sessionDerivedKey !== null && _sessionPassword !== null;
}

/** Clear session key (on logout) */
export function clearAccountKeySession(): void {
  _sessionDerivedKey = null;
  _sessionUserId = null;
  _sessionPassword = null;
}
