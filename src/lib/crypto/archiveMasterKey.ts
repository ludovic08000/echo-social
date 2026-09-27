import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';
import { secureGetSecret, secureSetSecret } from '@/lib/secureStore';
import { getSessionMasterKey, getSessionUserId } from '@/lib/crypto/accountKeyBackup';
import {
  masterKeyAADLabel,
} from '@/lib/crypto/masterKeyFormat';

const PBKDF2_ITERATIONS = 600_000;
const DEVICE_DB_NAME = 'forsure-archive-master-key';
const DEVICE_DB_VERSION = 1;
const DEVICE_STORE = 'keys';
const SECURE_PREFIX = 'forsure-archive-master-key:';

interface AccountBackupWrap {
  salt: string;
  wrapped_master_key: string;
  master_key_iv: string;
}

export type ArchiveMasterInitStatus = 'restored' | 'no_backup' | 'blocked';

let sessionUserId: string | null = null;
let sessionKey: CryptoKey | null = null;
let sessionRaw: Uint8Array | null = null;
let initInFlight: Promise<ArchiveMasterInitStatus> | null = null;

function resetSessionMaterial(): void {
  sessionKey = null;
  sessionUserId = null;
  sessionRaw?.fill(0);
  sessionRaw = null;
}

function passwordSecret(password: string, userId: string): string {
  return `${password}::forsure::${userId}`;
}

function buildBackupAAD(userId: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(masterKeyAADLabel(userId, 'account'));
}

async function deriveWrappingKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await hardCrypto.importKey(
    'raw',
    new hardGlobals.TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return hardCrypto.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function unwrapMasterKey(
  wrapped: string,
  iv: string,
  wrappingKey: CryptoKey,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const ivBytes = new Uint8Array(base64ToBuffer(iv));
  const ciphertext = base64ToBuffer(wrapped);

  const plaintext = await hardCrypto.decrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: aad.buffer.slice(aad.byteOffset, aad.byteOffset + aad.byteLength),
    },
    wrappingKey,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

async function importMasterKey(raw: Uint8Array): Promise<CryptoKey> {
  return hardCrypto.importKey(
    'raw',
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function openDeviceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb_unavailable'));
      return;
    }
    const request = indexedDB.open(DEVICE_DB_NAME, DEVICE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_STORE)) {
        db.createObjectStore(DEVICE_STORE, { keyPath: 'userId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('archive_master_db_open_failed'));
  });
}

async function persistDeviceKey(userId: string, key: CryptoKey, raw?: Uint8Array): Promise<void> {
  try {
    const db = await openDeviceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, 'readwrite');
      tx.objectStore(DEVICE_STORE).put({ userId, key, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('archive_master_db_write_failed'));
      tx.onabort = () => reject(tx.error ?? new Error('archive_master_db_write_aborted'));
    });
    db.close();
  } catch {
    // Safari private mode / disabled IndexedDB: keep the in-memory key.
  }

  if (raw && raw.byteLength === 32) {
    try {
      await secureSetSecret(
        `${SECURE_PREFIX}${userId}`,
        bufferToBase64(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer),
      );
    } catch {
      // Web has no Keychain/Keystore; IndexedDB remains the fallback.
    }
  }
}

function isUsableAesGcmKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CryptoKey> & {
    algorithm?: { name?: unknown };
    usages?: Iterable<unknown>;
  };
  let usages: unknown[] = [];
  try {
    usages = candidate.usages ? Array.from(candidate.usages) : [];
  } catch {
    return false;
  }
  return candidate.type === 'secret' &&
    candidate.algorithm?.name === 'AES-GCM' &&
    usages.includes('encrypt') &&
    usages.includes('decrypt');
}

async function loadSecureRawKey(userId: string): Promise<Uint8Array | null> {
  try {
    const encoded = await secureGetSecret(`${SECURE_PREFIX}${userId}`);
    if (!encoded) return null;
    const raw = new Uint8Array(base64ToBuffer(encoded));
    return raw.byteLength === 32 ? raw : null;
  } catch {
    return null;
  }
}

async function rawMatchesKey(raw: Uint8Array, key: CryptoKey): Promise<boolean> {
  try {
    const imported = await importMasterKey(raw);
    const iv = hardCrypto.getRandomValues(new Uint8Array(12));
    const plaintext = new hardGlobals.TextEncoder().encode('forsure-master-key-device-proof');
    const [candidateProof, rawProof] = await Promise.all([
      hardCrypto.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
      hardCrypto.encrypt({ name: 'AES-GCM', iv }, imported, plaintext),
    ]);
    const left = new Uint8Array(candidateProof);
    const right = new Uint8Array(rawProof);
    if (left.byteLength !== right.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < left.byteLength; index += 1) {
      difference |= left[index] ^ right[index];
    }
    return difference === 0;
  } catch {
    return false;
  }
}

async function loadDeviceKey(userId: string): Promise<CryptoKey | null> {
  try {
    const db = await openDeviceDb();
    const row = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, 'readonly');
      const request = tx.objectStore(DEVICE_STORE).get(userId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    // Structured-cloned CryptoKey objects are not guaranteed to preserve the
    // current realm's prototype (notably after an iOS/Android WebView reload).
    // Validate their cryptographic shape instead of relying on instanceof.
    if (isUsableAesGcmKey(row?.key)) {
      const raw = await loadSecureRawKey(userId);
      if (raw) {
        if (await rawMatchesKey(raw, row.key)) sessionRaw = raw;
        else raw.fill(0);
      }
      return row.key;
    }
  } catch {
    // Fall through to native secure storage.
  }

  try {
    const raw = await loadSecureRawKey(userId);
    if (!raw) return null;
    const key = await importMasterKey(raw);
    sessionRaw = raw.slice();
    await persistDeviceKey(userId, key);
    raw.fill(0);
    return key;
  } catch {
    return null;
  }
}

function publishReady(userId: string, source: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('forsure:archive-master-ready', {
      detail: { userId, source },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { reason: 'archive_master_ready', userId },
    }));
  } catch {
    // Browser event delivery is best-effort.
  }
}

async function adoptRawMasterKey(userId: string, raw: Uint8Array, source: string): Promise<void> {
  if (raw.byteLength !== 32) throw new Error('invalid_archive_master_key_length');
  const key = await importMasterKey(raw);
  resetSessionMaterial();
  sessionUserId = userId;
  sessionKey = key;
  sessionRaw = raw.slice();
  await persistDeviceKey(userId, key, raw);
  publishReady(userId, source);
}

/**
 * Load the already-established account Master Key without restoring or
 * replacing this device's own identity/ratchet stores.
 */
export async function initializeArchiveMasterKeyFromPassword(
  password: string,
  userId: string,
): Promise<ArchiveMasterInitStatus> {
  if (!password || !userId) return 'blocked';
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from('user_backups' as any)
        .select('salt, wrapped_master_key, master_key_iv')
        .eq('user_id', userId)
        .eq('backup_type', 'account')
        .maybeSingle();

      if (error) return 'blocked';
      if (!data) return 'no_backup';

      const backup = data as unknown as AccountBackupWrap;
      if (
        !backup.salt ||
        !backup.wrapped_master_key ||
        !backup.master_key_iv
      ) {
        return 'blocked';
      }

      const salt = new Uint8Array(base64ToBuffer(backup.salt));
      const wrappingKey = await deriveWrappingKey(passwordSecret(password, userId), salt);
      const aad = buildBackupAAD(userId);
      const raw = await unwrapMasterKey(
        backup.wrapped_master_key,
        backup.master_key_iv,
        wrappingKey,
        aad,
      );
      await adoptRawMasterKey(userId, raw, 'password_backup');
      raw.fill(0);
      return 'restored';
    } catch {
      // Existing backup + failed unwrap must never fall through to key creation.
      return 'blocked';
    }
  })();

  try {
    return await initInFlight;
  } finally {
    initInFlight = null;
  }
}

export async function initializeArchiveMasterKeyAfterBackupCreation(
  password: string,
  userId: string,
): Promise<ArchiveMasterInitStatus> {
  const delays = [0, 400, 1_200, 3_000];
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const status = await initializeArchiveMasterKeyFromPassword(password, userId);
    if (status !== 'no_backup') return status;
  }
  return 'no_backup';
}

export async function getArchiveMasterKey(userId: string): Promise<CryptoKey | null> {
  if (!userId) return null;
  if (sessionUserId === userId && sessionKey) return sessionKey;
  if (sessionUserId && sessionUserId !== userId) resetSessionMaterial();

  const persisted = await loadDeviceKey(userId);
  if (persisted) {
    sessionUserId = userId;
    sessionKey = persisted;
    publishReady(userId, 'device_store');
    return persisted;
  }

  // Reuse the one account Master Key already active in this session.
  if (getSessionUserId() === userId) {
    const accountMasterKey = getSessionMasterKey();
    if (accountMasterKey) {
      sessionUserId = userId;
      sessionKey = accountMasterKey;
      publishReady(userId, 'account_session');
      return accountMasterKey;
    }
  }

  return null;
}

/**
 * Return the device-persisted account Master Key and, when the secure store
 * retained it, a defensive copy of its raw bytes. Account restoration uses
 * the CryptoKey to authenticate/decrypt the authoritative server backup before
 * admitting messaging; a local key is never trusted on presence alone.
 */
export async function loadArchiveMasterKeyMaterial(userId: string): Promise<{
  key: CryptoKey;
  raw: Uint8Array | null;
} | null> {
  const key = await getArchiveMasterKey(userId);
  if (!key) return null;

  if (sessionUserId === userId && !sessionRaw) {
    const raw = await loadSecureRawKey(userId);
    if (raw) {
      if (await rawMatchesKey(raw, key)) sessionRaw = raw;
      else raw.fill(0);
    }
  }

  return {
    key,
    raw: sessionUserId === userId && sessionRaw ? sessionRaw.slice() : null,
  };
}

export async function exportArchiveMasterKeyForDeviceLink(userId: string): Promise<string | null> {
  if (sessionUserId !== userId || !sessionRaw) {
    await getArchiveMasterKey(userId);
  }
  if (sessionUserId !== userId || !sessionRaw || sessionRaw.byteLength !== 32) return null;
  return bufferToBase64(
    sessionRaw.buffer.slice(sessionRaw.byteOffset, sessionRaw.byteOffset + sessionRaw.byteLength) as ArrayBuffer,
  );
}

export async function importArchiveMasterKeyFromDeviceLink(
  encoded: string,
  userId: string,
): Promise<boolean> {
  try {
    const raw = new Uint8Array(base64ToBuffer(encoded));
    if (raw.byteLength !== 32) return false;
    await adoptRawMasterKey(userId, raw, 'device_link');
    raw.fill(0);
    return true;
  } catch {
    return false;
  }
}

export function clearArchiveMasterKeySession(): void {
  resetSessionMaterial();
}

if (typeof window !== 'undefined') {
  window.addEventListener('forsure:e2ee-purge', clearArchiveMasterKeySession);
}
