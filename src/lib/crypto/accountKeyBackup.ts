/**
 * Account-based Key Backup — Signal-style Master Key architecture (v5)
 * 
 * Architecture inspired by Signal SVR (Secure Value Recovery):
 * 
 * 1. A random 32-byte MASTER KEY is generated once per account
 * 2. The Master Key encrypts all E2EE material (identity, ratchets, prekeys, etc.)
 * 3. The Master Key itself is "wrapped" (encrypted) by TWO parallel mechanisms:
 *    a. PASSWORD wrapping: PBKDF2(password + userId) → wraps Master Key → stored as backup_type='account'
 *    b. RECOVERY KEY wrapping: PBKDF2(recoveryKey) → wraps Master Key → stored as backup_type='recovery'
 * 4. On login: password → unwrap Master Key → decrypt E2EE state
 * 5. On password change: just re-wrap the same Master Key (no re-encryption of state)
 * 6. On key loss + password lost: recovery key → unwrap Master Key → restore
 * 
 * The Master Key NEVER leaves the client in plaintext.
 * The password/recovery key NEVER leaves the client.
 */

import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { openE2EEDB } from '@/lib/crypto/indexedDb';
import { supabase } from '@/integrations/supabase/client';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { writeKeySentinel, clearKeySentinel } from '@/lib/crypto/keySentinel';
import { secureGetSecret, secureSetSecret, secureRemoveSecret } from '@/lib/secureStore';
// device_id continuity is now handled exclusively via the server-side
// fingerprint binding in hydrateDeviceId() — never restored from backup.

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const MASTER_KEY_LENGTH = 32;
const BACKUP_VERSION = 5; // v5 = Signal-style Master Key architecture
const BACKUP_TYPE_ACCOUNT = 'account';
const BACKUP_TYPE_RECOVERY = 'recovery';
const KEYCHAIN_SNAPSHOT_PREFIX = 'forsure-e2ee-keychain-snapshot-v1:';

// ── Session State (volatile, never persisted) ──
let _sessionMasterKey: CryptoKey | null = null;
let _sessionRawMasterKey: Uint8Array | null = null; // raw bytes for re-wrapping
let _sessionPassword: string | null = null;
let _sessionUserId: string | null = null;

// ── Crypto Primitives ──

async function deriveWrappingKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await hardCrypto.importKey(
    'raw',
    new hardGlobals.TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return hardCrypto.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function passwordSecret(password: string, userId: string): string {
  return `${password}::forsure::${userId}`;
}

/** Wrap (encrypt) the Master Key with a wrapping key */
async function wrapMasterKey(masterKeyRaw: Uint8Array, wrappingKey: CryptoKey): Promise<{ wrapped: string; iv: string }> {
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  // Use slice() to get a clean ArrayBuffer (no offset issues — Signal lesson)
  const ciphertext = await hardCrypto.encrypt({ name: 'AES-GCM', iv }, wrappingKey, masterKeyRaw.slice().buffer);
  return { wrapped: bufferToBase64(ciphertext), iv: bufferToBase64(iv.buffer) };
}

/** Unwrap (decrypt) the Master Key */
async function unwrapMasterKey(wrapped: string, iv: string, wrappingKey: CryptoKey): Promise<Uint8Array> {
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const ciphertext = base64ToBuffer(wrapped);
  const plainBuf = await hardCrypto.decrypt({ name: 'AES-GCM', iv: ivBuf }, wrappingKey, ciphertext);
  return new Uint8Array(plainBuf);
}

/** Import raw Master Key bytes into a CryptoKey for AES-GCM */
async function importMasterKey(raw: Uint8Array): Promise<CryptoKey> {
  // slice() ensures clean buffer with byteOffset=0 (Signal-style safety)
  return hardCrypto.importKey('raw', raw.slice().buffer, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt data with the Master Key */
async function encryptWithMasterKey(data: string, masterKey: CryptoKey): Promise<{ encrypted: string; iv: string }> {
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new hardGlobals.TextEncoder().encode(data);
  const ciphertext = await hardCrypto.encrypt({ name: 'AES-GCM', iv }, masterKey, encoded);
  return { encrypted: bufferToBase64(ciphertext), iv: bufferToBase64(iv.buffer) };
}

/** Decrypt data with the Master Key */
async function decryptWithMasterKey(encrypted: string, iv: string, masterKey: CryptoKey): Promise<string> {
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const ciphertext = base64ToBuffer(encrypted);
  const plainBuf = await hardCrypto.decrypt({ name: 'AES-GCM', iv: ivBuf }, masterKey, ciphertext);
  return new hardGlobals.TextDecoder().decode(plainBuf);
}

/** Generate a fresh random Master Key */
function generateMasterKey(): Uint8Array {
  return hardCrypto.getRandomValues(new Uint8Array(MASTER_KEY_LENGTH));
}

// ── IndexedDB helpers (shared with collectAllKeys / restoreAllKeys) ──

async function openDB(name: string, version: number, storeNames?: string[]): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = hardGlobals.idbOpen(name, version);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    if (storeNames) {
      req.onupgradeneeded = () => {
        for (const sn of storeNames) {
          if (!req.result.objectStoreNames.contains(sn)) {
            req.result.createObjectStore(sn, { keyPath: sn === 'ratchet-states' ? 'convId' : 'id' });
          }
        }
      };
    }
  });
}

async function getAllFromStore(db: IDBDatabase, storeName: string): Promise<any[]> {
  if (!db.objectStoreNames.contains(storeName)) return [];
  const tx = db.transaction(storeName, 'readonly');
  return new Promise<any[]>((resolve, reject) => {
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putAllInStore(db: IDBDatabase, storeName: string, records: any[]): Promise<void> {
  if (!db.objectStoreNames.contains(storeName)) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  store.clear();
  for (const r of records) store.put(r);
  await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
}

/** Collect all local E2EE keys for backup */
async function collectAllKeys(): Promise<string | null> {
  const data: Record<string, any> = {};

  try {
    const db = await openE2EEDB();
    for (const storeName of Array.from(db.objectStoreNames)) {
      data[`e2ee:${storeName}`] = await getAllFromStore(db, storeName);
    }
    db.close();
  } catch {}

  try {
    const db = await openDB('forsure-ratchet', 1);
    data['ratchet:states'] = await getAllFromStore(db, 'ratchet-states');
    db.close();
  } catch {}

  try {
    const db = await openDB('forsure-pin-wrap', 1);
    data['pinwrap:keys'] = await getAllFromStore(db, 'pin-wrapped-keys');
    db.close();
  } catch {}

  try {
    const db = await openDB('forsure-prekeys', 1);
    data['prekeys:private'] = await getAllFromStore(db, 'private-prekeys');
    db.close();
  } catch {}

  try {
    const db = await openDB('forsure-spk', 1);
    data['spk:private'] = await getAllFromStore(db, 'signed-prekeys');
    db.close();
  } catch {}

  try {
    const fps = localStorage.getItem('forsure-known-fps');
    if (fps) data['fingerprints'] = fps;
  } catch {}

  const hasIdentity = data['e2ee:identity-keys']?.length > 0 || data['pinwrap:keys']?.length > 0;
  if (!hasIdentity) return null;

  // NOTE: device:id is intentionally NOT backed up anymore. Restoring an old
  // device id forced the account back to a stale identity on every login,
  // making messages addressed to the *current* device undecipherable and
  // re-triggering the "Restaurer mes clés" banner. Server-side fingerprint
  // binding (resolve_device_id_by_fingerprint) now handles cross-session
  // device id continuity reliably.

  data['_meta'] = {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    stores: Object.keys(data).filter(k => k !== '_meta'),
  };

  return JSON.stringify(data);
}

async function writeKeychainSnapshot(userId: string, keysJson?: string): Promise<boolean> {
  try {
    const snapshot = keysJson ?? await collectAllKeys();
    if (!snapshot) return false;
    return await secureSetSecret(`${KEYCHAIN_SNAPSHOT_PREFIX}${userId}`, snapshot);
  } catch (e) {
    console.warn('[MasterKey] Keychain snapshot write failed:', e);
    return false;
  }
}

export async function syncKeychainSnapshotFromLocal(userId: string): Promise<boolean> {
  if (!(await hasLocalKeys())) return false;
  return writeKeychainSnapshot(userId);
}

export async function restoreKeysFromKeychainSnapshot(userId: string): Promise<'restored' | 'unavailable' | 'error'> {
  try {
    const snapshot = await secureGetSecret(`${KEYCHAIN_SNAPSHOT_PREFIX}${userId}`);
    if (!snapshot) return 'unavailable';

    await restoreAllKeys(snapshot);
    const validated = await hasLocalKeys();
    if (!validated) return 'error';

    console.log('[MasterKey] ✅ Keys restored from iOS Keychain snapshot');
    logCryptoError({
      severity: 'info', context: 'restore', errorCode: 'RESTORE_KEYCHAIN_SNAPSHOT_SUCCESS',
      errorMessage: 'E2EE keys restored from native Keychain snapshot',
      metadata: { userId },
    });
    return 'restored';
  } catch (e) {
    console.warn('[MasterKey] Keychain snapshot restore failed:', e);
    logCryptoException('restore', e, { severity: 'error', metadata: { stage: 'keychain_snapshot_restore', userId } });
    return 'error';
  }
}

/**
 * Restore all local E2EE keys from backup — TRULY ATOMIC.
 */
async function restoreAllKeys(json: string): Promise<void> {
  const data = JSON.parse(json);

  const hasIdentityKeys = data['e2ee:identity-keys']?.length > 0;
  const hasPinWrappedKeys = data['pinwrap:keys']?.length > 0;
  if (!hasIdentityKeys && !hasPinWrappedKeys) {
    throw new Error('Backup invalide : aucune clé d\'identité');
  }

  const rollbackOps: Array<() => Promise<void>> = [];

  try {
    // Phase 0: device_id is intentionally NOT restored from the backup blob
    // anymore. Doing so caused the account to revert to a stale device id on
    // every cold-start, which made messages addressed to the *current* device
    // permanently undecipherable. Continuity is now guaranteed by the server
    // fingerprint binding (resolve_device_id_by_fingerprint) executed in
    // hydrateDeviceId() before any crypto bootstrap.

    // Phase 1: E2EE stores
    for (const [key, records] of Object.entries(data)) {
      if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
      const storeName = key.replace('e2ee:', '');
      const db = await openE2EEDB();
      if (db.objectStoreNames.contains(storeName)) {
        const existing = await getAllFromStore(db, storeName);
        await putAllInStore(db, storeName, records);
        const sn = storeName;
        const ed = existing;
        rollbackOps.push(async () => {
          const rdb = await openE2EEDB();
          await putAllInStore(rdb, sn, ed);
          rdb.close();
        });
      }
      db.close();
    }

    // Phase 2: Ratchet states
    if (Array.isArray(data['ratchet:states'])) {
      const db = await openDB('forsure-ratchet', 1, ['ratchet-states']);
      const existing = await getAllFromStore(db, 'ratchet-states');
      await putAllInStore(db, 'ratchet-states', data['ratchet:states']);
      db.close();
      rollbackOps.push(async () => {
        const rdb = await openDB('forsure-ratchet', 1);
        await putAllInStore(rdb, 'ratchet-states', existing);
        rdb.close();
      });
    }

    // Phase 3: PIN-wrapped keys
    if (Array.isArray(data['pinwrap:keys'])) {
      const db = await openDB('forsure-pin-wrap', 1, ['pin-wrapped-keys']);
      const existing = await getAllFromStore(db, 'pin-wrapped-keys');
      await putAllInStore(db, 'pin-wrapped-keys', data['pinwrap:keys']);
      db.close();
      rollbackOps.push(async () => {
        const rdb = await openDB('forsure-pin-wrap', 1);
        await putAllInStore(rdb, 'pin-wrapped-keys', existing);
        rdb.close();
      });
    }

    // Phase 4: Private prekeys
    if (Array.isArray(data['prekeys:private'])) {
      const db = await openDB('forsure-prekeys', 1, ['private-prekeys']);
      const existing = await getAllFromStore(db, 'private-prekeys');
      await putAllInStore(db, 'private-prekeys', data['prekeys:private']);
      db.close();
      rollbackOps.push(async () => {
        const rdb = await openDB('forsure-prekeys', 1);
        await putAllInStore(rdb, 'private-prekeys', existing);
        rdb.close();
      });
    }

    // Phase 4b: Signed prekey private halves (required to decrypt X3DH/device copies)
    if (Array.isArray(data['spk:private'])) {
      const db = await openDB('forsure-spk', 1, ['signed-prekeys']);
      const existing = await getAllFromStore(db, 'signed-prekeys');
      await putAllInStore(db, 'signed-prekeys', data['spk:private']);
      db.close();
      rollbackOps.push(async () => {
        const rdb = await openDB('forsure-spk', 1);
        await putAllInStore(rdb, 'signed-prekeys', existing);
        rdb.close();
      });
    }

    // Phase 5: Fingerprints
    if (data['fingerprints']) {
      const oldFps = localStorage.getItem('forsure-known-fps');
      localStorage.setItem('forsure-known-fps', data['fingerprints']);
      rollbackOps.push(async () => {
        if (oldFps) localStorage.setItem('forsure-known-fps', oldFps);
        else localStorage.removeItem('forsure-known-fps');
      });
    }

    console.log('[MasterKey] ✅ Atomic restore complete');
  } catch (error) {
    console.error('[MasterKey] Restore failed, rolling back...', error);
    for (const rollback of rollbackOps.reverse()) {
      try { await rollback(); } catch (e) { console.warn('[MasterKey] Rollback step failed:', e); }
    }
    throw new Error(`Restore échoué et annulé : ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if local E2EE keys exist.
 */
export async function hasLocalKeys(): Promise<boolean> {
  try {
    const db = await openE2EEDB();
    let rawCount = 0;
    if (db.objectStoreNames.contains('identity-keys')) {
      const tx = db.transaction('identity-keys', 'readonly');
      rawCount = await new Promise<number>((r, j) => {
        const req = tx.objectStore('identity-keys').count();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });
    }
    db.close();
    if (rawCount > 0) return true;
  } catch {}

  try {
    const db = await openDB('forsure-pin-wrap', 1);
    let pinCount = 0;
    if (db.objectStoreNames.contains('pin-wrapped-keys')) {
      const tx = db.transaction('pin-wrapped-keys', 'readonly');
      pinCount = await new Promise<number>((r, j) => {
        const req = tx.objectStore('pin-wrapped-keys').count();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });
    }
    db.close();
    if (pinCount > 0) return true;
  } catch {}

  try {
    const db = await openDB('forsure-ratchet', 1);
    let ratchetCount = 0;
    if (db.objectStoreNames.contains('ratchet-states')) {
      const tx = db.transaction('ratchet-states', 'readonly');
      ratchetCount = await new Promise<number>((r, j) => {
        const req = tx.objectStore('ratchet-states').count();
        req.onsuccess = () => r(req.result); req.onerror = () => j(req.error);
      });
    }
    db.close();
    if (ratchetCount > 0) return true;
  } catch {}

  return false;
}

/**
 * SHA-256 digest of all local crypto state for change detection.
 */
export async function computeLocalCryptoDigest(): Promise<string> {
  const parts: string[] = [];

  try {
    const db = await openE2EEDB();
    for (const storeName of Array.from(db.objectStoreNames)) {
      const all = await getAllFromStore(db, storeName);
      parts.push(`${storeName}:${all.length}:${JSON.stringify(all).length}`);
    }
    db.close();
  } catch {}

  for (const [dbName, storeName] of [
    ['forsure-ratchet', 'ratchet-states'],
    ['forsure-pin-wrap', 'pin-wrapped-keys'],
    ['forsure-prekeys', 'private-prekeys'],
    ['forsure-spk', 'signed-prekeys'],
  ]) {
    try {
      const db = await openDB(dbName, 1);
      const all = await getAllFromStore(db, storeName);
      parts.push(`${storeName}:${all.length}:${JSON.stringify(all).length}`);
      db.close();
    } catch {}
  }

  const combined = parts.join('|');
  const hash = await hardCrypto.digest('SHA-256', new hardGlobals.TextEncoder().encode(combined));
  return bufferToBase64(hash);
}

// ── Server I/O ──

interface BackupRow {
  encrypted_blob: string;
  iv: string;
  salt: string;
  wrapped_master_key: string;
  master_key_iv: string;
  version: number;
  backup_type: string;
}

/**
 * Save the current E2EE state to server, encrypted with Master Key.
 * Also saves the password-wrapped Master Key.
 */
async function uploadBackup(
  masterKeyRaw: Uint8Array,
  masterKey: CryptoKey,
  password: string,
  userId: string,
  backupType: 'account' | 'recovery',
  wrappingSecret: string,
): Promise<boolean> {
  const keysJson = await collectAllKeys();
  if (!keysJson) return false;

  // 1. Encrypt all E2EE state with Master Key
  const { encrypted, iv: dataIv } = await encryptWithMasterKey(keysJson, masterKey);

  // 2. Wrap Master Key with the wrapping secret (password or recovery key)
  const salt = hardCrypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const wrappingKey = await deriveWrappingKey(wrappingSecret, salt);
  const { wrapped, iv: mkIv } = await wrapMasterKey(masterKeyRaw, wrappingKey);

  // 3. Upload
  const { error } = await supabase
    .from('user_backups' as any)
    .upsert({
      user_id: userId,
      encrypted_blob: encrypted,
      iv: dataIv,
      salt: bufferToBase64(salt.buffer),
      wrapped_master_key: wrapped,
      master_key_iv: mkIv,
      version: BACKUP_VERSION,
      backup_type: backupType,
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,backup_type' });

  if (error) throw error;

  // Persist a secure sentinel so cold-start on iOS/Android can detect that a
  // server backup exists for this user and trigger an automatic restore flow.
  if (backupType === 'account') {
    try {
      const digest = await computeLocalCryptoDigest();
      await writeKeychainSnapshot(userId, keysJson);
      await writeKeySentinel({
        userId,
        digest,
        lastSyncAt: Date.now(),
        backupVersion: BACKUP_VERSION,
      });
    } catch (e) {
      console.warn('[MasterKey] sentinel write failed:', e);
    }
  }

  return true;
}

/**
 * Restore from server: unwrap Master Key, decrypt E2EE state.
 */
async function downloadAndRestore(
  userId: string,
  backupType: 'account' | 'recovery',
  wrappingSecret: string,
): Promise<{ masterKeyRaw: Uint8Array; masterKey: CryptoKey } | null> {
  const { data } = await supabase
    .from('user_backups' as any)
    .select('encrypted_blob, iv, salt, wrapped_master_key, master_key_iv, version, backup_type')
    .eq('user_id', userId)
    .eq('backup_type', backupType)
    .maybeSingle();

  if (!data) return null;

  const backup = data as unknown as BackupRow;

  // v5 Master Key format
  if (backup.version >= 5 && backup.wrapped_master_key && backup.master_key_iv) {
    const saltBuf = new Uint8Array(base64ToBuffer(backup.salt));
    const wrappingKey = await deriveWrappingKey(wrappingSecret, saltBuf);
    const masterKeyRaw = await unwrapMasterKey(backup.wrapped_master_key, backup.master_key_iv, wrappingKey);
    const masterKey = await importMasterKey(masterKeyRaw);
    const json = await decryptWithMasterKey(backup.encrypted_blob, backup.iv, masterKey);
    await restoreAllKeys(json);
    return { masterKeyRaw, masterKey };
  }

  // Legacy v3/v4: password directly encrypts the state (no Master Key)
  if (backup.version >= 3 && backupType === 'account') {
    const saltBuf = new Uint8Array(base64ToBuffer(backup.salt));
    const ivBuf = new Uint8Array(base64ToBuffer(backup.iv));
    const key = await deriveWrappingKey(wrappingSecret, saltBuf);
    const ciphertext = base64ToBuffer(backup.encrypted_blob);
    const plainBuf = await hardCrypto.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ciphertext);
    const json = new hardGlobals.TextDecoder().decode(plainBuf);
    await restoreAllKeys(json);
    // Migrate: generate Master Key and re-upload in v5 format
    const mkRaw = generateMasterKey();
    const mk = await importMasterKey(mkRaw);
    console.log('[MasterKey] Migrating legacy v' + backup.version + ' → v5');
    await uploadBackup(mkRaw, mk, _sessionPassword || '', userId, 'account', wrappingSecret).catch(() => {});
    return { masterKeyRaw: mkRaw, masterKey: mk };
  }

  // Legacy v2: recovery key format
  if (backup.version === 2 && backupType === 'recovery') {
    const saltBuf = new Uint8Array(base64ToBuffer(backup.salt));
    const ivBuf = new Uint8Array(base64ToBuffer(backup.iv));
    const key = await deriveWrappingKey(wrappingSecret, saltBuf);
    const ciphertext = base64ToBuffer(backup.encrypted_blob);
    const plainBuf = await hardCrypto.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ciphertext);
    const json = new hardGlobals.TextDecoder().decode(plainBuf);
    await restoreAllKeys(json);
    const mkRaw = generateMasterKey();
    const mk = await importMasterKey(mkRaw);
    return { masterKeyRaw: mkRaw, masterKey: mk };
  }

  console.warn('[MasterKey] Incompatible backup version:', backup.version);
  return null;
}

// ── Public API ──

/**
 * Called at login time. Derives wrapping key from password, restores or creates Master Key.
 */
export async function initAccountKeySync(password: string, userId: string): Promise<'restored' | 'local_ok' | 'no_backup' | 'error'> {
  const t0 = performance.now();
  try {
    _sessionPassword = password;
    _sessionUserId = userId;
    const secret = passwordSecret(password, userId);

    const hasLocal = await hasLocalKeys();
    if (hasLocal) {
      console.log('[MasterKey] Local keys present');
      logCryptoError({
        severity: 'info', context: 'backup', errorCode: 'BACKUP_INIT_LOCAL_OK',
        errorMessage: 'Local E2EE keys present, no restore needed',
        metadata: { userId, durationMs: Math.round(performance.now() - t0) },
      });
      // If we don't have a Master Key yet, generate one and upload
      if (!_sessionMasterKey) {
        const mkRaw = generateMasterKey();
        const mk = await importMasterKey(mkRaw);
        _sessionRawMasterKey = mkRaw;
        _sessionMasterKey = mk;
        uploadBackup(mkRaw, mk, password, userId, 'account', secret).catch((e) => {
          logCryptoException('backup', e, { severity: 'warning', metadata: { stage: 'first_upload', userId } });
        });
      }
      return 'local_ok';
    }

    // No local keys — try restore from server
    console.log('[MasterKey] No local keys, attempting restore...');
    logCryptoError({
      severity: 'info', context: 'restore', errorCode: 'RESTORE_ATTEMPT',
      errorMessage: 'No local keys, attempting password-based restore',
      metadata: { userId },
    });
    try {
      const result = await downloadAndRestore(userId, 'account', secret);
      if (result) {
        // Post-restore validation: ensure local identity actually exists now
        const validated = await hasLocalKeys();
        if (!validated) {
          console.error('[MasterKey] ⛔ Restore reported success but no local identity found — failing restore');
          logCryptoError({
            severity: 'critical', context: 'restore', errorCode: 'RESTORE_VALIDATION_FAILED',
            errorMessage: 'Restore reported success but no local identity found',
            metadata: { userId, durationMs: Math.round(performance.now() - t0) },
          });
          return 'error';
        }
        _sessionRawMasterKey = result.masterKeyRaw;
        _sessionMasterKey = result.masterKey;
        await writeKeychainSnapshot(userId);
        console.log('[MasterKey] ✅ Keys restored from server (validated)');
        logCryptoError({
          severity: 'info', context: 'restore', errorCode: 'RESTORE_SUCCESS',
          errorMessage: 'E2EE keys restored from server backup',
          metadata: { userId, durationMs: Math.round(performance.now() - t0) },
        });
        return 'restored';
      }
    } catch (e) {
      console.warn('[MasterKey] Password-based restore failed:', e);
      logCryptoException('restore', e, {
        severity: 'error',
        metadata: { stage: 'password_restore', userId, durationMs: Math.round(performance.now() - t0) },
      });
    }

    console.log('[MasterKey] No server backup found');
    logCryptoError({
      severity: 'warning', context: 'restore', errorCode: 'RESTORE_NO_BACKUP',
      errorMessage: 'No server backup found for this account',
      metadata: { userId },
    });
    return 'no_backup';
  } catch (err) {
    console.error('[MasterKey] Init failed:', err);
    logCryptoException('backup', err, {
      severity: 'critical',
      metadata: { stage: 'init', userId, durationMs: Math.round(performance.now() - t0) },
    });
    return 'error';
  }
}

/**
 * Re-attempt restore using the in-memory password session when available.
 *
 * This only works inside the SAME JS lifetime as a successful password login.
 * It is intentionally unavailable after a full refresh because the password is
 * never persisted client-side.
 */
export async function restoreAccountKeysFromActiveSession(userId?: string): Promise<'restored' | 'local_ok' | 'unavailable' | 'error'> {
  const targetUserId = userId ?? _sessionUserId;
  const t0 = performance.now();

  try {
    const hasLocal = await hasLocalKeys();
    if (hasLocal) {
      console.log('[MasterKey] Active-session restore skipped: local crypto already present');
      return 'local_ok';
    }

    if (!_sessionPassword || !targetUserId || _sessionUserId !== targetUserId) {
      console.warn('[MasterKey] Active-session restore unavailable: no in-memory password session');
      return 'unavailable';
    }

    console.log('[MasterKey] Active-session restore attempting password-based recovery');
    const secret = passwordSecret(_sessionPassword, targetUserId);
    const result = await downloadAndRestore(targetUserId, 'account', secret);

    if (!result) {
      console.warn('[MasterKey] Active-session restore unavailable: no matching backup');
      return 'unavailable';
    }

    const validated = await hasLocalKeys();
    if (!validated) {
      console.error('[MasterKey] ⛔ Active-session restore succeeded but no local identity was restored');
      logCryptoError({
        severity: 'critical', context: 'restore', errorCode: 'RESTORE_ACTIVE_SESSION_VALIDATION_FAILED',
        errorMessage: 'Active-session restore succeeded but no local identity was restored',
        metadata: { userId: targetUserId, durationMs: Math.round(performance.now() - t0) },
      });
      return 'error';
    }

    _sessionRawMasterKey = result.masterKeyRaw;
    _sessionMasterKey = result.masterKey;
    await writeKeychainSnapshot(targetUserId);
    console.log('[MasterKey] ✅ Keys restored from active session');
    logCryptoError({
      severity: 'info', context: 'restore', errorCode: 'RESTORE_ACTIVE_SESSION_SUCCESS',
      errorMessage: 'E2EE keys restored from active in-memory session',
      metadata: { userId: targetUserId, durationMs: Math.round(performance.now() - t0) },
    });
    return 'restored';
  } catch (err) {
    console.error('[MasterKey] Active-session restore failed:', err);
    logCryptoException('restore', err, {
      severity: 'error',
      metadata: { stage: 'active_session_restore', userId: targetUserId, durationMs: Math.round(performance.now() - t0) },
    });
    return 'error';
  }
}

/**
 * Restore using a recovery key (fallback when password doesn't work).
 */
export async function restoreWithRecoveryKey(recoveryKey: string, userId: string): Promise<boolean> {
  const t0 = performance.now();
  try {
    logCryptoError({
      severity: 'info', context: 'restore', errorCode: 'RESTORE_RECOVERY_ATTEMPT',
      errorMessage: 'Attempting recovery-key restore',
      metadata: { userId },
    });
    const result = await downloadAndRestore(userId, 'recovery', recoveryKey);
    if (result) {
      // Post-restore validation: ensure local identity actually exists now
      const validated = await hasLocalKeys();
      if (!validated) {
        console.error('[MasterKey] ⛔ Recovery restore reported success but no local identity found');
        logCryptoError({
          severity: 'critical', context: 'restore', errorCode: 'RESTORE_RECOVERY_VALIDATION_FAILED',
          errorMessage: 'Recovery restore succeeded but no local identity found',
          metadata: { userId, durationMs: Math.round(performance.now() - t0) },
        });
        return false;
      }
      _sessionRawMasterKey = result.masterKeyRaw;
      _sessionMasterKey = result.masterKey;
      await writeKeychainSnapshot(userId);
      // Re-wrap with current password if available
      if (_sessionPassword && _sessionUserId) {
        const secret = passwordSecret(_sessionPassword, _sessionUserId);
        await uploadBackup(result.masterKeyRaw, result.masterKey, _sessionPassword, _sessionUserId, 'account', secret).catch((e) => {
          logCryptoException('backup', e, { severity: 'warning', metadata: { stage: 'rewrap_after_recovery', userId } });
        });
      }
      logCryptoError({
        severity: 'info', context: 'restore', errorCode: 'RESTORE_RECOVERY_SUCCESS',
        errorMessage: 'E2EE keys restored via recovery key',
        metadata: { userId, durationMs: Math.round(performance.now() - t0) },
      });
      return true;
    }
    logCryptoError({
      severity: 'warning', context: 'restore', errorCode: 'RESTORE_RECOVERY_NO_BACKUP',
      errorMessage: 'No recovery backup found or wrong key',
      metadata: { userId, durationMs: Math.round(performance.now() - t0) },
    });
    return false;
  } catch (e) {
    console.error('[MasterKey] Recovery key restore failed:', e);
    logCryptoException('restore', e, {
      severity: 'error',
      metadata: { stage: 'recovery_restore', userId, durationMs: Math.round(performance.now() - t0) },
    });
    return false;
  }
}

/**
 * Create a recovery-key-wrapped backup of the Master Key.
 * Returns the recovery key to show to user.
 */
export async function createRecoveryKeyBackup(userId: string): Promise<string | null> {
  if (!_sessionRawMasterKey || !_sessionMasterKey) {
    // Generate Master Key if we don't have one
    const mkRaw = generateMasterKey();
    const mk = await importMasterKey(mkRaw);
    _sessionRawMasterKey = mkRaw;
    _sessionMasterKey = mk;
  }

  const { generateRecoveryKey, normalizeRecoveryKey } = await import('@/lib/crypto/recoveryKey');
  const recoveryKey = generateRecoveryKey();
  const normalized = normalizeRecoveryKey(recoveryKey);

  try {
    await uploadBackup(_sessionRawMasterKey!, _sessionMasterKey!, _sessionPassword || '', userId, 'recovery', normalized);
    logCryptoError({
      severity: 'info', context: 'backup', errorCode: 'RECOVERY_BACKUP_CREATED',
      errorMessage: 'Recovery-key wrapped backup created',
      metadata: { userId },
    });
    return recoveryKey;
  } catch (e) {
    console.error('[MasterKey] Recovery backup creation failed:', e);
    logCryptoException('backup', e, { severity: 'error', metadata: { stage: 'recovery_backup_create', userId } });
    return null;
  }
}

/**
 * Sync current E2EE state to server (auto-sync on changes).
 */
export async function syncBackupToServer(): Promise<boolean> {
  if (!_sessionPassword || !_sessionUserId || !_sessionRawMasterKey || !_sessionMasterKey) {
    // Fallback: generate Master Key if session has password but no MK yet
    if (_sessionPassword && _sessionUserId) {
      const mkRaw = generateMasterKey();
      const mk = await importMasterKey(mkRaw);
      _sessionRawMasterKey = mkRaw;
      _sessionMasterKey = mk;
    } else {
      return false;
    }
  }

  try {
    const secret = passwordSecret(_sessionPassword!, _sessionUserId!);
    const ok = await uploadBackup(_sessionRawMasterKey!, _sessionMasterKey!, _sessionPassword!, _sessionUserId!, 'account', secret);
    if (ok) {
      console.log('[MasterKey] ✅ Backup synced');
      logCryptoError({
        severity: 'info', context: 'backup', errorCode: 'BACKUP_SYNCED',
        errorMessage: 'Master Key backup synced to server',
        metadata: { userId: _sessionUserId },
      });
    } else {
      logCryptoError({
        severity: 'warning', context: 'backup', errorCode: 'BACKUP_SYNC_NO_OP',
        errorMessage: 'uploadBackup returned false',
        metadata: { userId: _sessionUserId },
      });
    }
    return ok;
  } catch (err) {
    console.warn('[MasterKey] Sync failed:', err);
    logCryptoException('backup', err, { severity: 'error', metadata: { stage: 'sync', userId: _sessionUserId } });
    return false;
  }
}

/** Check if auto-backup session is active */
export function isAutoBackupActive(): boolean {
  return _sessionPassword !== null && _sessionUserId !== null;
}

/** Clear session state (on logout) */
export function clearAccountKeySession(): void {
  _sessionMasterKey = null;
  _sessionRawMasterKey = null;
  _sessionPassword = null;
  _sessionUserId = null;
  // The sentinel is intentionally NOT cleared here — logout doesn't mean the
  // account is gone, and we want the next cold-start on the same device to
  // still recognise the linked user. Call `clearKeySentinelForAccount()` from
  // an explicit "remove account from this device" action instead.
}

/** Explicit per-device account unlink — wipes the secure sentinel. */
export async function clearKeySentinelForAccount(): Promise<void> {
  if (_sessionUserId) {
    await secureRemoveSecret(`${KEYCHAIN_SNAPSHOT_PREFIX}${_sessionUserId}`);
  }
  await clearKeySentinel();
}
