import { supabase } from '@/integrations/supabase/client';
import { setupBackupPin, syncBackupToServer } from '@/lib/crypto/accountKeyBackup';
import { exportArchiveMasterKeyForDeviceLink } from '@/lib/crypto/archiveMasterKey';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const MASTER_KEY_LENGTH = 32;
const PIN_BACKUP_KDF_VERSION = 1;

type SetupPinResult = 'ok' | 'no_master_key' | 'invalid_pin' | 'error';

type SupabaseErrorLike = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  status?: number;
};

function isValidPin(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}

function pinSecret(pin: string, userId: string): string {
  return `pin::forsure::${userId}::${pin}`;
}

function buildPinBackupAAD(userId: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(
    `forsure-backup|${userId}|pin|v${PIN_BACKUP_KDF_VERSION}`,
  );
}

function logServerError(stage: string, error: unknown): void {
  const value = (error ?? {}) as SupabaseErrorLike;
  console.warn(`[AEGIS-PIN] ${stage}`, {
    code: value.code ?? null,
    status: value.status ?? null,
    message: value.message ?? String(error ?? 'unknown_error'),
    details: value.details ?? null,
    hint: value.hint ?? null,
  });
}

async function ensureAuthenticatedSession(userId: string): Promise<boolean> {
  const { data: current, error: currentError } = await supabase.auth.getSession();
  if (!currentError && current.session?.user.id === userId) return true;

  const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
  if (!refreshError && refreshed.session?.user.id === userId) return true;

  logServerError('authenticated session unavailable before PIN backup', refreshError ?? currentError);
  return false;
}

async function pinBackupExists(userId: string): Promise<boolean | null> {
  const { data, error } = await supabase.rpc(
    'has_backup_pin' as never,
    { _user_id: userId } as never,
  );
  if (error) {
    logServerError('has_backup_pin verification failed', error);
    return null;
  }
  return data === true;
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
    ['encrypt'],
  );
}

async function waitForArchiveMasterKey(userId: string): Promise<Uint8Array | null> {
  const delays = [0, 150, 350, 750, 1_500, 3_000];

  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const encoded = await exportArchiveMasterKeyForDeviceLink(userId);
    if (!encoded) continue;

    const raw = new Uint8Array(base64ToBuffer(encoded));
    if (raw.byteLength === MASTER_KEY_LENGTH) return raw;
    raw.fill(0);
  }

  return null;
}

async function setupFromArchiveMasterKey(pin: string, userId: string): Promise<SetupPinResult> {
  const rawMasterKey = await waitForArchiveMasterKey(userId);
  if (!rawMasterKey) return 'no_master_key';

  try {
    if (!(await ensureAuthenticatedSession(userId))) return 'error';

    const salt = hardCrypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const wrappingKey = await deriveWrappingKey(pinSecret(pin, userId), salt);
    const aad = buildPinBackupAAD(userId);
    const wrapped = await hardCrypto.encrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
        additionalData: aad.buffer.slice(aad.byteOffset, aad.byteOffset + aad.byteLength),
      },
      wrappingKey,
      rawMasterKey.buffer.slice(
        rawMasterKey.byteOffset,
        rawMasterKey.byteOffset + rawMasterKey.byteLength,
      ),
    );

    const packed = `${bufferToBase64(
      iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
    )}.${bufferToBase64(wrapped)}`;

    const { error } = await supabase
      .from('backup_pin_state' as never)
      .upsert({
        user_id: userId,
        salt: bufferToBase64(
          salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
        ),
        pin_wrap_master: packed,
        kdf_version: PIN_BACKUP_KDF_VERSION,
        attempts_count: 0,
        attempts_window_start: new Date().toISOString(),
        locked_until: null,
      } as never, { onConflict: 'user_id' });

    if (error) {
      logServerError('Supabase backup upsert failed', error);
      return 'error';
    }

    const exists = await pinBackupExists(userId);
    if (exists === false) {
      console.warn('[AEGIS-PIN] upsert returned success but has_backup_pin returned false');
      return 'error';
    }

    console.info('[AEGIS-PIN] encrypted PIN backup persisted');
    return 'ok';
  } catch (error) {
    logServerError('archive-key wrapping failed', error);
    return 'error';
  } finally {
    rawMasterKey.fill(0);
  }
}

async function setupFromAccountMasterKey(pin: string, userId: string): Promise<SetupPinResult> {
  let result = await setupBackupPin(pin, userId);
  if (result !== 'no_master_key') return result;

  // Login and PIN setup can finish in adjacent tasks. Give the password-backed
  // account session a bounded opportunity to create/upload its Master Key,
  // then wrap that exact key with the PIN. This never creates an account
  // identity and never overwrites an existing fingerprint.
  const delays = [0, 150, 350, 750, 1_500];
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const synchronized = await syncBackupToServer().catch(() => false);
    if (!synchronized) continue;
    result = await setupBackupPin(pin, userId);
    if (result !== 'no_master_key') return result;
  }

  return result;
}

/**
 * Persist the PIN backup without depending on which Aegis session currently
 * owns the already-restored account Master Key.
 */
export async function setupPersistentBackupPin(pin: string, userId: string): Promise<SetupPinResult> {
  if (!isValidPin(pin)) return 'invalid_pin';
  if (!(await ensureAuthenticatedSession(userId))) return 'error';

  // Prefer the account-key path. If a transient auth/session race made the
  // first write fail, refresh once and retry before the archive fallback.
  let accountResult = await setupFromAccountMasterKey(pin, userId);
  if (accountResult === 'ok' || accountResult === 'invalid_pin') return accountResult;

  if (accountResult === 'error') {
    const alreadyStored = await pinBackupExists(userId);
    if (alreadyStored === true) return 'ok';

    const { error: refreshError } = await supabase.auth.refreshSession();
    if (!refreshError) {
      accountResult = await setupFromAccountMasterKey(pin, userId);
      if (accountResult === 'ok') return 'ok';
    } else {
      logServerError('session refresh before PIN retry failed', refreshError);
    }

    if (accountResult === 'error') {
      const afterRetry = await pinBackupExists(userId);
      if (afterRetry === true) return 'ok';
      console.warn('[AEGIS-PIN] account PIN backup failed after authenticated retry');
      return 'error';
    }
  }

  return setupFromArchiveMasterKey(pin, userId);
}
