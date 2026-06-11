import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer } from './utils';
import { loadIdentityKeys, saveIdentityKeys, type IdentityKeyPair } from './keyManager';
import { exportKeyToJWK, importKeyFromJWK } from './utils';
import { KX_KEY_PARAMS, SIG_KEY_PARAMS } from './constants';

const VAULT_VERSION = 1;
const RECOVERY_KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const KDF_ITERATIONS = 600_000;
const BACKUP_TYPE_RECOVERY_KEY = 'recovery_key_vault';

export interface SecureBackupVaultPayload {
  version: number;
  createdAt: string;
  userId: string;
  identity: {
    publicKeyJWK: JsonWebKey;
    privateKeyJWK: JsonWebKey;
    signingPublicKeyJWK: JsonWebKey;
    signingPrivateKeyJWK: JsonWebKey;
    createdAt: number;
    fingerprint: string;
  };
}

export interface CreatedSecureBackupVault {
  recoveryKey: string;
  fingerprint: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function normalizeRecoveryKey(input: string): string {
  return input.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function formatRecoveryKey(hex: string): string {
  return hex.match(/.{1,4}/g)?.join('-') ?? hex;
}

async function deriveVaultKey(recoveryKey: string, salt: Uint8Array): Promise<CryptoKey> {
  const normalized = normalizeRecoveryKey(recoveryKey);
  if (normalized.length !== RECOVERY_KEY_BYTES * 2) {
    throw new Error('Recovery key invalide');
  }

  const material = await hardCrypto.importKey(
    'raw',
    new hardGlobals.TextEncoder().encode(normalized),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return hardCrypto.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function exportIdentityPayload(userId: string, keys: IdentityKeyPair): Promise<SecureBackupVaultPayload> {
  const anyKeys = keys as any;
  const privateKeyJWK = anyKeys._privJWK ?? await exportKeyToJWK(keys.privateKey);
  const signingPrivateKeyJWK = anyKeys._sigPrivJWK ?? await exportKeyToJWK(keys.signingPrivateKey);

  return {
    version: VAULT_VERSION,
    createdAt: new Date().toISOString(),
    userId,
    identity: {
      publicKeyJWK: await exportKeyToJWK(keys.publicKey),
      privateKeyJWK,
      signingPublicKeyJWK: await exportKeyToJWK(keys.signingPublicKey),
      signingPrivateKeyJWK,
      createdAt: keys.createdAt,
      fingerprint: keys.fingerprint,
    },
  };
}

async function importIdentityPayload(payload: SecureBackupVaultPayload): Promise<IdentityKeyPair> {
  if (!payload?.identity?.privateKeyJWK || !payload?.identity?.signingPrivateKeyJWK) {
    throw new Error('Backup invalide : clé privée absente');
  }

  const [publicKey, privateKey, signingPublicKey, signingPrivateKey] = await Promise.all([
    importKeyFromJWK(payload.identity.publicKeyJWK, KX_KEY_PARAMS as any, [], true),
    importKeyFromJWK(payload.identity.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false),
    importKeyFromJWK(payload.identity.signingPublicKeyJWK, SIG_KEY_PARAMS as any, ['verify'], true),
    importKeyFromJWK(payload.identity.signingPrivateKeyJWK, SIG_KEY_PARAMS as any, ['sign'], false),
  ]);

  return {
    publicKey,
    privateKey,
    signingPublicKey,
    signingPrivateKey,
    createdAt: payload.identity.createdAt,
    fingerprint: payload.identity.fingerprint,
    ...(({ _privJWK: payload.identity.privateKeyJWK, _sigPrivJWK: payload.identity.signingPrivateKeyJWK }) as any),
  };
}

export async function createSecureBackupVault(userId: string): Promise<CreatedSecureBackupVault | null> {
  const keys = await loadIdentityKeys(userId);
  if (!keys) return null;

  const rawRecovery = hardCrypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  const recoveryKey = formatRecoveryKey(bytesToHex(rawRecovery));
  const salt = hardCrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const vaultKey = await deriveVaultKey(recoveryKey, salt);
  const payload = await exportIdentityPayload(userId, keys);

  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv },
    vaultKey,
    new hardGlobals.TextEncoder().encode(JSON.stringify(payload)),
  );

  const { error } = await supabase
    .from('user_backups' as any)
    .upsert({
      user_id: userId,
      backup_type: BACKUP_TYPE_RECOVERY_KEY,
      version: VAULT_VERSION,
      encrypted_blob: bufferToBase64(ciphertext),
      iv: bufferToBase64(iv.buffer),
      salt: bufferToBase64(salt.buffer),
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,backup_type' });

  if (error) throw error;

  return { recoveryKey, fingerprint: keys.fingerprint };
}

export async function restoreSecureBackupVault(userId: string, recoveryKey: string): Promise<IdentityKeyPair | null> {
  const { data, error } = await supabase
    .from('user_backups' as any)
    .select('encrypted_blob, iv, salt, version, backup_type, created_at')
    .eq('user_id', userId)
    .eq('backup_type', BACKUP_TYPE_RECOVERY_KEY)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as any;
  const salt = new Uint8Array(base64ToBuffer(row.salt));
  const iv = new Uint8Array(base64ToBuffer(row.iv));
  const vaultKey = await deriveVaultKey(recoveryKey, salt);
  const plain = await hardCrypto.decrypt({ name: 'AES-GCM', iv }, vaultKey, base64ToBuffer(row.encrypted_blob));
  const payload = JSON.parse(new hardGlobals.TextDecoder().decode(plain)) as SecureBackupVaultPayload;

  if (payload.userId !== userId) {
    throw new Error('Backup invalide : userId mismatch');
  }

  const keys = await importIdentityPayload(payload);
  await saveIdentityKeys(userId, keys);
  return keys;
}

export async function hasSecureBackupVault(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('user_backups' as any)
    .select('id')
    .eq('user_id', userId)
    .eq('backup_type', BACKUP_TYPE_RECOVERY_KEY)
    .limit(1)
    .maybeSingle();

  return !!data;
}
