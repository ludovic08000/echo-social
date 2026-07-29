import { supabase } from '@/integrations/supabase/client';
import { setupBackupPin } from '@/lib/crypto/accountKeyBackup';
import { exportArchiveMasterKeyForDeviceLink } from '@/lib/crypto/archiveMasterKey';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const MASTER_KEY_LENGTH = 32;
const PIN_BACKUP_KDF_VERSION = 1;

type SetupPinResult = 'ok' | 'no_master_key' | 'invalid_pin' | 'error';

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
      console.warn('[AEGIS-PIN] Supabase backup upsert failed:', error.message);
      return 'error';
    }

    return 'ok';
  } catch (error) {
    console.warn('[AEGIS-PIN] archive-key wrapping failed:', error);
    return 'error';
  } finally {
    rawMasterKey.fill(0);
  }
}

/**
 * Persist the PIN backup without depending on which Aegis session currently
 * owns the already-restored account Master Key.
 */
export async function setupPersistentBackupPin(pin: string, userId: string): Promise<SetupPinResult> {
  if (!isValidPin(pin)) return 'invalid_pin';

  const legacyResult = await setupBackupPin(pin, userId);
  if (legacyResult !== 'no_master_key') return legacyResult;

  return setupFromArchiveMasterKey(pin, userId);
}
