/**
 * Account-based Key Backup — single Aegis account Master Key architecture.
 * 
 * Signal-inspired invariant: one stable, random Master Key per account.
 * This browser implementation is not Signal SVR: a short PIN cannot provide
 * offline-bruteforce resistance without an enclave/HSM-backed online service.
 * 
 * 1. A random 32-byte MASTER KEY is generated once per account
 * 2. The portable vault contains only the permanent account identity and the
 *    account-scoped fingerprint continuity cache. Ratchets, prekeys and device
 *    identities remain device-local (native Keychain/Keystore snapshot only).
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
import { getCurrentDeviceId, adoptDeviceIdFromBackup } from '@/lib/messaging/currentDevice';
import {
  exportPlaintextCache,
  importPlaintextCache,
  type PlaintextCacheExportEntry,
} from '@/lib/crypto/plaintextStore';
import { runPostRestoreSync, type RestoreReason } from '@/lib/crypto/postRestoreSync';
import {
  createSingleFlightByKey,
  decidePasswordChangeReadiness,
  decideMasterKeyCreation,
  selectPortableAccountIdentityRows,
  type PasswordChangeReadiness,
} from '@/lib/crypto/aegisContinuityGuards';
import {
  masterKeyAADLabel,
  type AegisMasterKeyBackupType,
} from '@/lib/crypto/masterKeyFormat';

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const MASTER_KEY_LENGTH = 32;
const BACKUP_TYPE_ACCOUNT = 'account';
const BACKUP_TYPE_RECOVERY = 'recovery';
const KEYCHAIN_SNAPSHOT_PREFIX = 'forsure-e2ee-keychain-snapshot:';

/** Domain-separated AAD bound to owner, purpose and the only accepted schema. */
function buildBackupAAD(userId: string, backupType: AegisMasterKeyBackupType): Uint8Array {
  return new hardGlobals.TextEncoder().encode(masterKeyAADLabel(userId, backupType));
}

/** Domain separator for the recovery key (mirrors passwordSecret to avoid cross-secret collisions). */
function recoverySecret(recoveryKey: string, userId: string): string {
  return `recovery::forsure::${userId}::${recoveryKey}`;
}

// ── Session State (volatile, never persisted) ──
let _sessionMasterKey: CryptoKey | null = null;
let _sessionRawMasterKey: Uint8Array | null = null; // raw bytes for re-wrapping
let _sessionPassword: string | null = null;
let _sessionUserId: string | null = null;

type AccountKeyInitStatus = 'restored' | 'local_ok' | 'no_backup' | 'error';
const runAccountKeyInitSingleFlight = createSingleFlightByKey<AccountKeyInitStatus>();

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

/** Wrap the Master Key with mandatory authenticated context. */
async function wrapMasterKey(masterKeyRaw: Uint8Array, wrappingKey: CryptoKey, aad: Uint8Array): Promise<{ wrapped: string; iv: string }> {
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const params: AesGcmParams = { name: 'AES-GCM', iv, additionalData: aad.slice().buffer };
  // Use slice() to get a clean ArrayBuffer (no offset issues — Signal lesson)
  const ciphertext = await hardCrypto.encrypt(params, wrappingKey, masterKeyRaw.slice().buffer);
  return { wrapped: bufferToBase64(ciphertext), iv: bufferToBase64(iv.buffer) };
}

/** Unwrap the Master Key with mandatory authenticated context. */
async function unwrapMasterKey(wrapped: string, iv: string, wrappingKey: CryptoKey, aad: Uint8Array): Promise<Uint8Array> {
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const ciphertext = base64ToBuffer(wrapped);
  const plainBuf = await hardCrypto.decrypt({ name: 'AES-GCM', iv: ivBuf, additionalData: aad.slice().buffer }, wrappingKey, ciphertext);
  return new Uint8Array(plainBuf);
}

/** Import raw Master Key bytes into a CryptoKey for AES-GCM */
async function importMasterKey(raw: Uint8Array): Promise<CryptoKey> {
  // slice() ensures clean buffer with byteOffset=0 (Signal-style safety)
  return hardCrypto.importKey('raw', raw.slice().buffer, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt data with the Master Key and mandatory authenticated context. */
async function encryptWithMasterKey(data: string, masterKey: CryptoKey, aad: Uint8Array): Promise<{ encrypted: string; iv: string }> {
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new hardGlobals.TextEncoder().encode(data);
  const params: AesGcmParams = { name: 'AES-GCM', iv, additionalData: aad.slice().buffer };
  const ciphertext = await hardCrypto.encrypt(params, masterKey, encoded);
  return { encrypted: bufferToBase64(ciphertext), iv: bufferToBase64(iv.buffer) };
}

/** Decrypt data with the Master Key and mandatory authenticated context. */
async function decryptWithMasterKey(encrypted: string, iv: string, masterKey: CryptoKey, aad: Uint8Array): Promise<string> {
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const ciphertext = base64ToBuffer(encrypted);
  const plainBuf = await hardCrypto.decrypt({ name: 'AES-GCM', iv: ivBuf, additionalData: aad.slice().buffer }, masterKey, ciphertext);
  return new hardGlobals.TextDecoder().decode(plainBuf);
}

/** Generate a fresh random Master Key */
function generateMasterKey(): Uint8Array {
  return hardCrypto.getRandomValues(new Uint8Array(MASTER_KEY_LENGTH));
}

// ── IndexedDB helpers (shared with collectAllKeys / restoreAllKeys) ──
//
// All side-DBs are routed through the central dbRegistry + runTxOn so Safari
// transient errors and concurrent-tx wedges are handled uniformly. Only the
// E2EE singleton (openE2EEDB) keeps its own helper because it predates this
// stack.

import { runTxOn } from './indexedDbTx';
import type { DBKey } from './dbRegistry';

/** Map legacy DB names used in this file to registered DBKey ids. */
const LEGACY_DB_TO_KEY: Record<string, Exclude<DBKey, 'e2ee-keys'>> = {
  'forsure-ratchet': 'ratchet',
  'forsure-pin-wrap': 'pin-wrap',
  'forsure-prekeys': 'prekeys',
  'forsure-spk': 'spk',
  'forsure-device-sessions': 'device-sessions',
};

function dbKeyForLegacyName(name: string): Exclude<DBKey, 'e2ee-keys'> {
  const k = LEGACY_DB_TO_KEY[name];
  if (!k) throw new Error(`[accountKeyBackup] Unknown legacy DB name: ${name}`);
  return k;
}

/** Read all rows from a side-DB store via the registry/runTxOn pipeline. */
async function getAllFromSideDB(dbName: string, storeName: string): Promise<any[]> {
  const key = dbKeyForLegacyName(dbName);
  try {
    return await runTxOn(key, [storeName], 'readonly', (tx) => {
      return new Promise<any[]>((resolve, reject) => {
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = () => reject(req.error);
      });
    });
  } catch (e) {
    // Missing store after a failed upgrade → treat as empty rather than throw.
    if (e instanceof DOMException && e.name === 'NotFoundError') return [];
    throw e;
  }
}

/** Atomically clear+repopulate a side-DB store. */
async function putAllInSideDB(dbName: string, storeName: string, records: any[]): Promise<void> {
  const key = dbKeyForLegacyName(dbName);
  await runTxOn(key, [storeName], 'readwrite', (tx) => {
    return new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(storeName);
      const clearReq = store.clear();
      clearReq.onerror = () => reject(clearReq.error);
      clearReq.onsuccess = () => {
        try {
          for (const r of records) store.put(r);
          resolve();
        } catch (err) {
          reject(err);
        }
      };
    });
  });
}

/** Count rows in a side-DB store (used by hasLocalKeys / digest). */
async function countSideDB(dbName: string, storeName: string): Promise<number> {
  const key = dbKeyForLegacyName(dbName);
  try {
    return await runTxOn(key, [storeName], 'readonly', (tx) => {
      return new Promise<number>((resolve, reject) => {
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return 0;
    throw e;
  }
}

/** Read all rows from an E2EE singleton store (kept separate from side-DBs). */
async function getAllFromStore(db: IDBDatabase, storeName: string): Promise<any[]> {
  if (!db.objectStoreNames.contains(storeName)) return [];
  const tx = db.transaction(storeName, 'readonly');
  return new Promise<any[]>((resolve, reject) => {
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Write all rows into an E2EE singleton store (kept separate from side-DBs). */
async function putAllInStore(db: IDBDatabase, storeName: string, records: any[]): Promise<void> {
  if (!db.objectStoreNames.contains(storeName)) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  store.clear();
  for (const r of records) store.put(r);
  await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
}

type BackupScope = 'aegis-vault' | 'device-keychain';

/** Collect portable account material or physical-device recovery material. */
async function collectAllKeys(userId: string, scope: BackupScope = 'aegis-vault'): Promise<string | null> {
  const data: Record<string, any> = {};
  const includeDeviceSecrets = scope === 'device-keychain';

  try {
    const db = await openE2EEDB();
    for (const storeName of Array.from(db.objectStoreNames)) {
      if (!includeDeviceSecrets && storeName !== 'identity-keys') continue;
      const rows = await getAllFromStore(db, storeName);
      data[`e2ee:${storeName}`] = storeName === 'identity-keys' && !includeDeviceSecrets
        ? selectPortableAccountIdentityRows(rows, userId)
        : rows;
    }
    // db.close() skipped — shared singleton, see indexedDb.ts
  } catch {}

  if (includeDeviceSecrets) {
    try {
      data['pinwrap:keys'] = await getAllFromSideDB('forsure-pin-wrap', 'wrapped-keys');
    } catch {
      // Optional when this device has never wrapped an identity with a PIN.
    }
    try {
      data['prekeys:private'] = await getAllFromSideDB('forsure-prekeys', 'private-prekeys');
    } catch {}
    try {
      data['spk:private'] = await getAllFromSideDB('forsure-spk', 'signed-prekeys');
    } catch {}
  }

  try {
    const fps = localStorage.getItem('forsure-known-fps');
    if (fps) {
      const parsed = JSON.parse(fps) as Record<string, unknown>;
      const scoped = Object.fromEntries(Object.entries(parsed).filter(
        ([key, value]) => key.startsWith(`${userId}:`) && typeof value === 'string',
      ));
      if (Object.keys(scoped).length > 0) data['fingerprints'] = JSON.stringify(scoped);
    }
  } catch {}

  const hasIdentity = data['e2ee:identity-keys']?.some((row: any) => row?.id === userId);
  if (!hasIdentity) return null;

  if (includeDeviceSecrets) {
    try {
      data['device:id'] = getCurrentDeviceId();
    } catch {}
  }

  if (includeDeviceSecrets) try {
    // Decrypted history is confined to the native device snapshot. The
    // portable account vault is identity continuity, not a chat backup.
    const plaintextCache = await exportPlaintextCache();
    if (plaintextCache.length > 0) data['plaintext:cache'] = plaintextCache;
  } catch {}

  data['_meta'] = {
    scope,
    userId,
    createdAt: new Date().toISOString(),
    stores: Object.keys(data).filter(k => k !== '_meta'),
  };

  return JSON.stringify(data);
}

async function writeKeychainSnapshot(userId: string, keysJson?: string): Promise<boolean> {
  try {
    const snapshot = keysJson ?? await collectAllKeys(userId, 'device-keychain');
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

    await restoreAllKeys(snapshot, userId);
    const validated = await hasLocalAccountIdentity(userId);
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
async function restoreAllKeys(json: string, userId: string): Promise<void> {
  const data = JSON.parse(json);
  const isDeviceKeychain = data?._meta?.scope === 'device-keychain';
  const backupUserId = typeof data?._meta?.userId === 'string' ? data._meta.userId : null;

  // Correction : un coffre Aegis n'a plus de branche de version à interpréter.
  if (backupUserId !== userId) {
    throw new Error('Backup invalide : propriétaire du coffre incorrect');
  }

  const hasIdentityKeys = data['e2ee:identity-keys']?.some(
    (row: any) => row?.id === userId,
  );
  if (!hasIdentityKeys) {
    throw new Error('Backup invalide : aucune clé d\'identité');
  }

  const rollbackOps: Array<() => Promise<void>> = [];

  try {
    // Phase 0: restore the encrypted device routing id before restoring the
    // matching per-device private key. This keeps message device-copies readable
    // after iOS/WebView storage purges without showing a "verify device" flow.
    if (isDeviceKeychain && typeof data['device:id'] === 'string' && data['device:id'].length >= 16) {
      adoptDeviceIdFromBackup(data['device:id']);
    }

    // Phase 1: E2EE stores
    for (const [key, records] of Object.entries(data)) {
      if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
      const storeName = key.replace('e2ee:', '');
      if (!isDeviceKeychain && storeName !== 'identity-keys') continue;
      const safeRecords = storeName === 'identity-keys' && !isDeviceKeychain
        ? selectPortableAccountIdentityRows(records, userId)
        : records;
      const db = await openE2EEDB();
      if (db.objectStoreNames.contains(storeName)) {
        const existing = await getAllFromStore(db, storeName);
        const recordsToWrite = storeName === 'identity-keys' && !isDeviceKeychain
          ? [
            ...existing.filter((row: any) => row?.id !== userId),
            ...safeRecords,
          ]
          : safeRecords;
        await putAllInStore(db, storeName, recordsToWrite);
        const sn = storeName;
        const ed = existing;
        rollbackOps.push(async () => {
          const rdb = await openE2EEDB();
          await putAllInStore(rdb, sn, ed);
          // db.close() skipped — shared singleton, see indexedDb.ts
        });
      }
      // db.close() skipped — shared singleton, see indexedDb.ts
    }

    if (isDeviceKeychain && Array.isArray(data['device:kx'])) {
      const currentDeviceKxId = `device-kx::${getCurrentDeviceId()}`;
      const deviceKx = data['device:kx'].filter((r: any) => r?.id === currentDeviceKxId);
      if (deviceKx.length > 0) {
        const db = await openE2EEDB();
        const existing = await getAllFromStore(db, 'identity-keys');
        await putAllInStore(db, 'identity-keys', [...existing.filter((r: any) => r?.id !== currentDeviceKxId), ...deviceKx]);
        // db.close() skipped — shared singleton, see indexedDb.ts
      }
    }

    // Phase 2: PIN-wrapped keys
    if (isDeviceKeychain && Array.isArray(data['pinwrap:keys'])) {
      const wrappedKeys = data['pinwrap:keys'].filter((record: unknown) => {
        if (!record || typeof record !== 'object') return false;
        const candidate = record as Record<string, unknown>;
        return candidate.version === 1 &&
          typeof candidate.id === 'string' &&
          typeof candidate.salt === 'string' &&
          typeof candidate.iv === 'string' &&
          typeof candidate.ciphertext === 'string';
      });
      const existing = await getAllFromSideDB('forsure-pin-wrap', 'wrapped-keys');
      await putAllInSideDB('forsure-pin-wrap', 'wrapped-keys', wrappedKeys);
      rollbackOps.push(async () => {
        await putAllInSideDB('forsure-pin-wrap', 'wrapped-keys', existing);
      });
    }

    // Phase 4: Private prekeys
    if (isDeviceKeychain && Array.isArray(data['prekeys:private'])) {
      const existing = await getAllFromSideDB('forsure-prekeys', 'private-prekeys');
      await putAllInSideDB('forsure-prekeys', 'private-prekeys', data['prekeys:private']);
      rollbackOps.push(async () => {
        await putAllInSideDB('forsure-prekeys', 'private-prekeys', existing);
      });
    }

    // Phase 4b: Signed prekey private halves (required to decrypt X3DH/device copies)
    if (isDeviceKeychain && Array.isArray(data['spk:private'])) {
      const existing = await getAllFromSideDB('forsure-spk', 'signed-prekeys');
      await putAllInSideDB('forsure-spk', 'signed-prekeys', data['spk:private']);
      rollbackOps.push(async () => {
        await putAllInSideDB('forsure-spk', 'signed-prekeys', existing);
      });
    }

    // Phase 5: Fingerprints
    if (data['fingerprints']) {
      const oldFps = localStorage.getItem('forsure-known-fps');
      const current = JSON.parse(oldFps || '{}') as Record<string, unknown>;
      const restored = JSON.parse(data['fingerprints']) as Record<string, unknown>;
      const scoped = Object.fromEntries(Object.entries(restored).filter(
        ([key, value]) => key.startsWith(`${userId}:`) && typeof value === 'string',
      ));
      localStorage.setItem('forsure-known-fps', JSON.stringify({ ...current, ...scoped }));
      rollbackOps.push(async () => {
        if (oldFps) localStorage.setItem('forsure-known-fps', oldFps);
        else localStorage.removeItem('forsure-known-fps');
      });
    }

    // Phase 6: recent decrypted history cache. This is already encrypted at
    // rest by the Master Key backup, and re-imports into an IndexedDB cache
    // protected by a fresh local AES key. It lets the app show the latest
    // messages/media immediately after iOS clears WebView storage.
    if (Array.isArray(data['plaintext:cache'])) {
      await importPlaintextCache(data['plaintext:cache'] as PlaintextCacheExportEntry[]);
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
    // db.close() skipped — shared singleton, see indexedDb.ts
    if (rawCount > 0) return true;
  } catch {}

  try {
    const pinCount = await countSideDB('forsure-pin-wrap', 'wrapped-keys');
    if (pinCount > 0) return true;
  } catch {}

  try {
    const ratchetCount = await countSideDB('forsure-ratchet', 'ratchet-states');
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
    // db.close() skipped — shared singleton, see indexedDb.ts
  } catch {}

  for (const [dbName, storeName] of [
    ['forsure-ratchet', 'ratchet-states'],
    ['forsure-pin-wrap', 'wrapped-keys'],
    ['forsure-prekeys', 'private-prekeys'],
    ['forsure-spk', 'signed-prekeys'],
  ]) {
    try {
      const all = await getAllFromSideDB(dbName, storeName);
      parts.push(`${storeName}:${all.length}:${JSON.stringify(all).length}`);
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
  const keysJson = await collectAllKeys(userId, 'aegis-vault');
  if (!keysJson) return false;

  // 1. Encrypt all E2EE state with Master Key and its authenticated context.
  const aad = buildBackupAAD(userId, backupType);
  const { encrypted, iv: dataIv } = await encryptWithMasterKey(keysJson, masterKey, aad);

  // 2. Wrap Master Key with the wrapping secret (password or recovery key), AAD-bound
  const salt = hardCrypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const wrappingKey = await deriveWrappingKey(wrappingSecret, salt);
  const { wrapped, iv: mkIv } = await wrapMasterKey(masterKeyRaw, wrappingKey, aad);

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
      backup_type: backupType,
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,backup_type' });

  if (error) throw error;

  // Persist a secure sentinel so cold-start on iOS/Android can detect that a
  // server backup exists for this user and trigger an automatic restore flow.
  if (backupType === 'account') {
    try {
      const digest = await computeLocalCryptoDigest();
      await writeKeychainSnapshot(userId);
      await writeKeySentinel({
        userId,
        digest,
        lastSyncAt: Date.now(),
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
  const { data, error } = await supabase
    .from('user_backups' as any)
    .select('encrypted_blob, iv, salt, wrapped_master_key, master_key_iv, backup_type')
    .eq('user_id', userId)
    .eq('backup_type', backupType)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const backup = data as unknown as BackupRow;

  if (!backup.wrapped_master_key || !backup.master_key_iv) {
    console.warn('[MasterKey] Rejected incomplete backup');
    return null;
  }

  const saltBuf = new Uint8Array(base64ToBuffer(backup.salt));
  const wrappingKey = await deriveWrappingKey(wrappingSecret, saltBuf);
  const aad = buildBackupAAD(userId, backupType);
  const masterKeyRaw = await unwrapMasterKey(backup.wrapped_master_key, backup.master_key_iv, wrappingKey, aad);
  const masterKey = await importMasterKey(masterKeyRaw);
  const json = await decryptWithMasterKey(backup.encrypted_blob, backup.iv, masterKey, aad);
  await restoreAllKeys(json, userId);
  return { masterKeyRaw, masterKey };
}

// ── Public API ──

async function hasLocalAccountIdentity(userId: string): Promise<boolean> {
  const { loadIdentityKeys } = await import('@/lib/crypto/keyManager');
  return Boolean(await loadIdentityKeys(userId));
}

interface RemoteMasterKeyContinuity {
  complete: boolean;
  activeFingerprint: string | null;
  hasAccountBackup: boolean;
  hasRecoveryBackup: boolean;
}

async function inspectRemoteMasterKeyContinuity(
  userId: string,
): Promise<RemoteMasterKeyContinuity> {
  const [backupsResult, identityResult] = await Promise.all([
    supabase
      .from('user_backups' as any)
      .select('backup_type')
      .eq('user_id', userId),
    supabase
      .from('user_public_keys' as any)
      .select('fingerprint')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  const backupTypes = new Set(
    ((backupsResult.data ?? []) as Array<{ backup_type?: unknown }>)
      .map((row) => row.backup_type)
      .filter((value): value is string => typeof value === 'string'),
  );

  return {
    complete: !backupsResult.error && !identityResult.error,
    activeFingerprint: identityResult.error
      ? null
      : ((identityResult.data as { fingerprint?: string } | null)?.fingerprint ?? null),
    hasAccountBackup: backupTypes.has(BACKUP_TYPE_ACCOUNT),
    hasRecoveryBackup: backupTypes.has(BACKUP_TYPE_RECOVERY),
  };
}

async function initAccountKeySyncOnce(
  password: string,
  userId: string,
): Promise<AccountKeyInitStatus> {
  const t0 = performance.now();
  try {
    if (_sessionUserId && _sessionUserId !== userId) {
      _sessionMasterKey = null;
      _sessionRawMasterKey?.fill(0);
      _sessionRawMasterKey = null;
    }
    _sessionPassword = password;
    _sessionUserId = userId;
    const secret = passwordSecret(password, userId);
    const localIdentityBefore = await hasLocalAccountIdentity(userId);

    if (_sessionMasterKey && _sessionRawMasterKey && localIdentityBefore) {
      dispatchSessionUnlocked(userId);
      return 'local_ok';
    }

    let restored: Awaited<ReturnType<typeof downloadAndRestore>>;
    try {
      restored = await downloadAndRestore(userId, 'account', secret);
    } catch (error) {
      logCryptoException('restore', error, {
        severity: 'error',
        metadata: { stage: 'authoritative_master_key_restore', userId },
      });
      return 'error';
    }

    if (restored) {
      if (!(await hasLocalAccountIdentity(userId))) {
        logCryptoError({
          severity: 'critical', context: 'restore', errorCode: 'RESTORE_VALIDATION_FAILED',
          errorMessage: 'Master Key restored but account identity is still absent',
          metadata: { userId, durationMs: Math.round(performance.now() - t0) },
        });
        return 'error';
      }

      _sessionRawMasterKey = restored.masterKeyRaw;
      _sessionMasterKey = restored.masterKey;
      dispatchSessionUnlocked(userId);
      await writeKeychainSnapshot(userId);
      void runPostRestoreSync(userId, 'password_sign_in');
      return 'restored';
    }

    const continuity = await inspectRemoteMasterKeyContinuity(userId);
    const { loadIdentityKeys } = await import('@/lib/crypto/keyManager');
    const localIdentity = await loadIdentityKeys(userId);
    const creationDecision = decideMasterKeyCreation({
      complete: continuity.complete,
      localIdentityFingerprint: localIdentity?.fingerprint ?? null,
      activeIdentityFingerprint: continuity.activeFingerprint,
      hasAccountBackup: continuity.hasAccountBackup,
      hasRecoveryBackup: continuity.hasRecoveryBackup,
    });

    if (creationDecision === 'unavailable') {
      logCryptoError({
        severity: 'error', context: 'backup', errorCode: 'MASTER_KEY_CONTINUITY_UNAVAILABLE',
        errorMessage: 'Master Key creation refused because server continuity inspection was incomplete',
        metadata: { userId },
      });
      return 'error';
    }

    // If another recovery mechanism already references a Master Key, absence
    // of the password-wrapped account row is damage/recovery state, never proof
    // that a new key may be generated.
    if (creationDecision === 'recovery_required') {
      logCryptoError({
        severity: 'critical', context: 'backup', errorCode: 'MASTER_KEY_RECOVERY_REQUIRED',
        errorMessage: 'Existing recovery evidence forbids replacement Master Key generation',
        metadata: { userId },
      });
      return 'error';
    }

    if (creationDecision === 'no_local_identity') {
      return 'no_backup';
    }

    if (creationDecision === 'identity_mismatch') {
      logCryptoError({
        severity: 'critical', context: 'backup', errorCode: 'MASTER_KEY_IDENTITY_MISMATCH',
        errorMessage: 'Master Key creation refused because account identity continuity did not match',
        metadata: { userId },
      });
      return 'error';
    }

    if (creationDecision !== 'create_first_key') return 'error';

    const mkRaw = generateMasterKey();
    const mk = await importMasterKey(mkRaw);
    const uploaded = await uploadBackup(mkRaw, mk, password, userId, 'account', secret);
    if (!uploaded) {
      mkRaw.fill(0);
      return 'error';
    }

    _sessionRawMasterKey = mkRaw;
    _sessionMasterKey = mk;
    dispatchSessionUnlocked(userId);
    await writeKeychainSnapshot(userId);
    return 'local_ok';
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
 * Called at login time. Restores the authoritative account Master Key or,
 * only for a verified first backup, creates exactly one key per account.
 */
export function initAccountKeySync(
  password: string,
  userId: string,
): Promise<AccountKeyInitStatus> {
  return runAccountKeyInitSingleFlight(userId, () => initAccountKeySyncOnce(password, userId));
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
    dispatchSessionUnlocked(targetUserId);
    await writeKeychainSnapshot(targetUserId);
    console.log('[MasterKey] ✅ Keys restored from active session');
    logCryptoError({
      severity: 'info', context: 'restore', errorCode: 'RESTORE_ACTIVE_SESSION_SUCCESS',
      errorMessage: 'E2EE keys restored from active in-memory session',
      metadata: { userId: targetUserId, durationMs: Math.round(performance.now() - t0) },
    });
    void runPostRestoreSync(targetUserId, 'password_active_session');
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
 * Silent re-hydration when IndexedDB has been wiped *during* an active session
 * (typical iOS Safari/PWA storage purge). Uses the Master Key already in RAM —
 * no password prompt, no UI surface. Returns:
 *  - 'restored'    : keys restored from server backup
 *  - 'local_ok'    : local keys still present, nothing to do
 *  - 'unavailable' : no in-RAM Master Key OR no server backup
 *  - 'error'       : decryption failed
 */
export async function restoreFromInMemoryMasterKey(userId?: string): Promise<'restored' | 'local_ok' | 'unavailable' | 'error'> {
  const targetUserId = userId ?? _sessionUserId;
  try {
    if (await hasLocalKeys()) return 'local_ok';
    if (!_sessionMasterKey || !targetUserId) return 'unavailable';

    const { data } = await supabase
      .from('user_backups' as any)
      .select('encrypted_blob, iv, backup_type')
      .eq('user_id', targetUserId)
      .eq('backup_type', 'account')
      .maybeSingle();
    if (!data) return 'unavailable';

    const backup = data as unknown as { encrypted_blob: string; iv: string };

    const aad = buildBackupAAD(targetUserId, 'account');
    const json = await decryptWithMasterKey(backup.encrypted_blob, backup.iv, _sessionMasterKey, aad);
    await restoreAllKeys(json, targetUserId);
    if (!(await hasLocalKeys())) return 'error';

    await writeKeychainSnapshot(targetUserId);
    console.log('[MasterKey] ✅ Silent re-hydration via in-RAM Master Key');
    logCryptoError({
      severity: 'info', context: 'restore', errorCode: 'RESTORE_INMEM_MK_SUCCESS',
      errorMessage: 'E2EE keys silently restored using in-memory Master Key',
      metadata: { userId: targetUserId },
    });
    void runPostRestoreSync(targetUserId, 'in_memory_master_key');
    return 'restored';
  } catch (e) {
    console.warn('[MasterKey] In-memory MK restore failed:', e);
    logCryptoException('restore', e, { severity: 'error', metadata: { stage: 'inmem_mk_restore', userId: targetUserId } });
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
    const result = await downloadAndRestore(userId, 'recovery', recoverySecret(recoveryKey, userId)).catch(() => null);
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
      _sessionUserId = userId;
      dispatchSessionUnlocked(userId);
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
      void runPostRestoreSync(userId, 'recovery_key');
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
 * Correction : le mot de passe Auth ne change jamais avant de savoir si la
 * même Master Key peut être ré-enveloppée. Une sauvegarde existante sans clé
 * en mémoire impose une restauration authentifiée.
 */
export async function inspectPasswordChangeReadiness(
  userId: string,
): Promise<PasswordChangeReadiness> {
  if (_sessionUserId === userId && _sessionMasterKey && _sessionRawMasterKey) {
    return decidePasswordChangeReadiness({
      hasActiveMasterKey: true,
      hasAccountBackup: false,
      inspectionFailed: false,
    });
  }

  try {
    const { data, error } = await supabase
      .from('user_backups' as any)
      .select('id')
      .eq('user_id', userId)
      .eq('backup_type', 'account')
      .maybeSingle();
    return decidePasswordChangeReadiness({
      hasActiveMasterKey: false,
      hasAccountBackup: Boolean(data),
      inspectionFailed: Boolean(error),
    });
  } catch {
    return decidePasswordChangeReadiness({
      hasActiveMasterKey: false,
      hasAccountBackup: false,
      inspectionFailed: true,
    });
  }
}

/** Ré-enveloppe la Master Key active sous le nouveau mot de passe. */
export async function rewrapMasterKeyForNewPassword(
  newPassword: string,
  userId: string,
): Promise<boolean> {
  if (
    !newPassword ||
    _sessionUserId !== userId ||
    !_sessionMasterKey ||
    !_sessionRawMasterKey
  ) {
    return false;
  }

  const secret = passwordSecret(newPassword, userId);
  try {
    const written = await uploadBackup(
      _sessionRawMasterKey,
      _sessionMasterKey,
      newPassword,
      userId,
      'account',
      secret,
    );
    if (!written) return false;
    _sessionPassword = newPassword;
    return true;
  } catch (error) {
    logCryptoException('backup', error, {
      severity: 'error',
      metadata: { stage: 'password_change_rewrap', userId },
    });
    return false;
  }
}

/**
 * Create a recovery-key-wrapped backup of the Master Key.
 * Returns the recovery key to show to user.
 */
export async function createRecoveryKeyBackup(userId: string): Promise<string | null> {
  if (!_sessionRawMasterKey || !_sessionMasterKey || _sessionUserId !== userId) {
    console.warn('[MasterKey] Recovery backup refused: authoritative account Master Key is unavailable');
    return null;
  }

  const { generateRecoveryKey, normalizeRecoveryKey } = await import('@/lib/crypto/recoveryKey');
  const recoveryKey = generateRecoveryKey();
  const normalized = normalizeRecoveryKey(recoveryKey);

  try {
    await uploadBackup(_sessionRawMasterKey!, _sessionMasterKey!, _sessionPassword || '', userId, 'recovery', recoverySecret(normalized, userId));
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
    console.warn('[MasterKey] Sync refused: authoritative account Master Key session is unavailable');
    return false;
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

// ── Reactive background backup (WhatsApp-style) ──
//
// Any key mutation (new ratchet step, SPK rotation, OPK refill) should call
// `requestBackgroundBackup()`. Calls are debounced (1.5 s) and coalesced so a
// burst of mutations only produces a single network upload. This guarantees
// the server-side backup tracks the local state within ~2 s, which is what
// keeps history readable on iOS even if Safari purges IndexedDB.
let _bgBackupTimer: ReturnType<typeof setTimeout> | null = null;
let _bgBackupInFlight = false;
let _bgBackupPendingReason: string | null = null;
let _bgBackupDirty = false;
let _bgBackupLifecycleInstalled = false;
const BG_BACKUP_DEBOUNCE_MS = 1_500;

function runCoalescedBackupNow(reason: string): void {
  if (!isAutoBackupActive()) return;
  if (_bgBackupTimer) {
    clearTimeout(_bgBackupTimer);
    _bgBackupTimer = null;
  }
  if (_bgBackupInFlight) {
    _bgBackupDirty = true;
    _bgBackupPendingReason = reason;
    return;
  }

  _bgBackupDirty = false;
  _bgBackupInFlight = true;
  const why = _bgBackupPendingReason ?? reason;
  _bgBackupPendingReason = null;
  syncBackupToServer()
    .catch((e) => console.warn(`[MasterKey] background backup (${why}) failed:`, e))
    .finally(() => {
      _bgBackupInFlight = false;
      if (_bgBackupDirty) requestBackgroundBackup(_bgBackupPendingReason ?? 'queued-mutation');
    });
}

function installBackupLifecycleFlush(): void {
  if (_bgBackupLifecycleInstalled || typeof window === 'undefined') return;
  _bgBackupLifecycleInstalled = true;

  const flush = () => {
    if (!_bgBackupDirty && !_bgBackupTimer) return;
    runCoalescedBackupNow('lifecycle-flush');
  };

  window.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

export function requestBackgroundBackup(reason: string = 'mutation'): void {
  if (!isAutoBackupActive()) return;
  installBackupLifecycleFlush();
  _bgBackupDirty = true;
  _bgBackupPendingReason = reason;
  if (_bgBackupTimer) clearTimeout(_bgBackupTimer);
  _bgBackupTimer = setTimeout(() => {
    runCoalescedBackupNow(_bgBackupPendingReason ?? reason);
  }, BG_BACKUP_DEBOUNCE_MS);
}

/** Force a near-immediate backup for user-visible decrypt/send milestones. */
export function requestImmediateBackup(reason: string = 'critical-mutation'): void {
  if (!isAutoBackupActive()) return;
  _bgBackupPendingReason = reason;
  if (_bgBackupTimer) {
    clearTimeout(_bgBackupTimer);
    _bgBackupTimer = null;
  }
  if (_bgBackupInFlight) {
    _bgBackupTimer = setTimeout(() => requestImmediateBackup(reason), BG_BACKUP_DEBOUNCE_MS);
    return;
  }
  _bgBackupInFlight = true;
  const why = _bgBackupPendingReason ?? reason;
  _bgBackupPendingReason = null;
  syncBackupToServer()
    .catch((e) => console.warn(`[MasterKey] immediate backup (${why}) failed:`, e))
    .finally(() => { _bgBackupInFlight = false; });
}

/** Clear session state (on logout) */
export function clearAccountKeySession(): void {
  _sessionMasterKey = null;
  // Correction : on écrase les octets secrets avant d'abandonner la référence.
  _sessionRawMasterKey?.fill(0);
  _sessionRawMasterKey = null;
  _sessionPassword = null;
  _sessionUserId = null;
  // The sentinel is intentionally NOT cleared here — logout doesn't mean the
  // account is gone, and we want the next cold-start on the same device to
  // still recognise the linked user. Call `clearKeySentinelForAccount()` from
  // an explicit "remove account from this device" action instead.
}

/**
 * Returns the in-RAM account master key for the active session, if any.
 * Used by features that derive long-lived per-resource keys wrapped under
 * the user's master key (e.g. conversation archive keys).
 *
 * Returns null when no session is unlocked — callers must degrade gracefully
 * (no archive, no recovery), never throw.
 */
export function getSessionMasterKey(): CryptoKey | null {
  return _sessionMasterKey;
}

/**
 * Broadcasts that the session master key just became available. Listeners
 * (e.g. conversation archive preloader) can warm up their caches.
 * Safe no-op outside the browser.
 */
export function dispatchSessionUnlocked(userId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-unlocked', { detail: { userId: userId || _sessionUserId } }));
  } catch { /* noop */ }
}

export function getSessionUserId(): string | null {
  return _sessionUserId;
}

/** Explicit per-device account unlink — wipes the secure sentinel. */
export async function clearKeySentinelForAccount(): Promise<void> {
  if (_sessionUserId) {
    await secureRemoveSecret(`${KEYCHAIN_SNAPSHOT_PREFIX}${_sessionUserId}`);
  }
  await clearKeySentinel();
}
