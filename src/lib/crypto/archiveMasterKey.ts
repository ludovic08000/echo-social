import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';
import { secureGetSecret, secureSetSecret } from '@/lib/secureStore';
import { getSessionMasterKey, getSessionUserId } from '@/lib/crypto/accountKeyBackup';

const PBKDF2_ITERATIONS = 600_000;
const DEVICE_DB_NAME = 'forsure-archive-master-key';
const DEVICE_DB_VERSION = 1;
const DEVICE_STORE = 'keys';
const SECURE_PREFIX = 'forsure-archive-master-key-v1:';

interface AccountBackupWrap {
  salt: string;
  wrapped_master_key: string;
  master_key_iv: string;
  version: number;
}

export type ArchiveMasterInitStatus = 'restored' | 'no_backup' | 'blocked';

let sessionUserId: string | null = null;
let sessionKey: CryptoKey | null = null;
let sessionRaw: Uint8Array | null = null;
let initInFlight: Promise<ArchiveMasterInitStatus> | null = null;

function passwordSecret(password: string, userId: string): string {
  return `${password}::forsure::${userId}`;
}

function buildBackupAAD(userId: string, version: number): Uint8Array {
  return new hardGlobals.TextEncoder().encode(`forsure-backup|${userId}|account|v${version}`);
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
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const ivBytes = new Uint8Array(base64ToBuffer(iv));
  const ciphertext = base64ToBuffer(wrapped);

  if (aad) {
    try {
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
    } catch {
      // v5 backups were not AAD-bound.
    }
  }

  const plaintext = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
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
    if (row?.key instanceof CryptoKey) return row.key;
  } catch {
    // Fall through to native secure storage.
  }

  try {
    const encoded = await secureGetSecret(`${SECURE_PREFIX}${userId}`);
    if (!encoded) return null;
    const raw = new Uint8Array(base64ToBuffer(encoded));
    if (raw.byteLength !== 32) return null;
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
  if (sessionUserId === userId && sessionKey) return 'restored';
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from('user_backups' as any)
        .select('salt, wrapped_master_key, master_key_iv, version')
        .eq('user_id', userId)
        .eq('backup_type', 'account')
        .maybeSingle();

      if (error) return 'blocked';
      if (!data) return 'no_backup';

      const backup = data as unknown as AccountBackupWrap;
      if (
        backup.version < 5 ||
        !backup.salt ||
        !backup.wrapped_master_key ||
        !backup.master_key_iv
      ) {
        return 'blocked';
      }

      const salt = new Uint8Array(base64ToBuffer(backup.salt));
      const wrappingKey = await deriveWrappingKey(passwordSecret(password, userId), salt);
      const aad = backup.version >= 6 ? buildBackupAAD(userId, backup.version) : undefined;
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

  const persisted = await loadDeviceKey(userId);
  if (persisted) {
    sessionUserId = userId;
    sessionKey = persisted;
    publishReady(userId, 'device_store');
    return persisted;
  }

  // Compatibility fallback for sessions restored by PIN/recovery through the
  // existing account backup module.
  if (getSessionUserId() === userId) {
    const legacy = getSessionMasterKey();
    if (legacy) {
      sessionUserId = userId;
      sessionKey = legacy;
      publishReady(userId, 'account_session');
      return legacy;
    }
  }

  return null;
}

export async function exportArchiveMasterKeyForDeviceLink(userId: string): Promise<string | null> {
  if (sessionUserId !== userId || !sessionRaw) {
    await getArchiveMasterKey(userId);
  }
  if (sessionUserId !== userId || !sessionRaw || sessionRaw.byteLength !== 32) return null;
  return bufferToBase64(
    sessionRaw.buffer.slice(sessionRaw.byteOffset, sessionRaw.byteOffset + sessionRaw.byteLength),
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
  sessionKey = null;
  sessionUserId = null;
  if (sessionRaw) sessionRaw.fill(0);
  sessionRaw = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('forsure:e2ee-purge', clearArchiveMasterKeySession);
}
