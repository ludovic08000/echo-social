import { STORE_KEYS } from '@/lib/crypto/constants';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { runTx, reqToPromise } from '@/lib/crypto/indexedDbTx';
import { getSessionMasterKey } from '@/lib/crypto/accountKeyBackup';
import {
  deviceVaultMirrorsPlaintext,
  readDeviceVaultRecord,
  writeDeviceVaultRecord,
} from '@/lib/crypto/deviceVault';


const VAULT_VERSION = 1 as const;
const IV_BYTES = 12;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

interface StoredDeviceIdentityRecovery {
  id: string;
  userId: string;
  deviceId: string;
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  createdAt: number;
}

interface StoredDeviceKxRecovery {
  id: string;
  userId: string;
  deviceId: string;
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  createdAt: number;
}

interface PlainDeviceVault {
  version: typeof VAULT_VERSION;
  userId: string;
  deviceId: string;
  signing: StoredDeviceIdentityRecovery;
  kx: StoredDeviceKxRecovery;
  createdAt: number;
}

export interface EncryptedWebDeviceVault {
  version: typeof VAULT_VERSION;
  iv: string;
  ciphertext: string;
}

function signingStorageKey(userId: string, deviceId: string): string {
  return `device-signing::${userId}::${deviceId}`;
}

function kxStorageKey(userId: string, deviceId: string): string {
  return `device-kx::${userId}::${deviceId}`;
}

function aad(userId: string, deviceId: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(
    `FORSURE-WEBAUTHN-DEVICE-VAULT-v1|${userId}|${deviceId}`,
  );
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return hardGlobals.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('WEBAUTHN_DEVICE_VAULT_BASE64_INVALID');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = hardGlobals.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validOkpJwk(value: JsonWebKey | undefined, curve: 'Ed25519' | 'X25519', requirePrivate: boolean): boolean {
  return Boolean(
    value
      && value.kty === 'OKP'
      && value.crv === curve
      && typeof value.x === 'string'
      && value.x.length >= 40
      && (!requirePrivate || (typeof value.d === 'string' && value.d.length >= 40)),
  );
}

function validateSigningRecord(value: unknown, userId: string, deviceId: string): value is StoredDeviceIdentityRecovery {
  const record = value as Partial<StoredDeviceIdentityRecovery> | null;
  return Boolean(
    record
      && record.id === signingStorageKey(userId, deviceId)
      && record.userId === userId
      && record.deviceId === deviceId
      && validOkpJwk(record.publicKeyJWK, 'Ed25519', false)
      && validOkpJwk(record.privateKeyJWK, 'Ed25519', true)
      && record.publicKeyJWK?.x === record.privateKeyJWK?.x
      && typeof record.createdAt === 'number'
      && Number.isFinite(record.createdAt),
  );
}

function validateKxRecord(value: unknown, userId: string, deviceId: string): value is StoredDeviceKxRecovery {
  const record = value as Partial<StoredDeviceKxRecovery> | null;
  return Boolean(
    record
      && record.id === kxStorageKey(userId, deviceId)
      && record.userId === userId
      && record.deviceId === deviceId
      && validOkpJwk(record.publicKeyJWK, 'X25519', false)
      && validOkpJwk(record.privateKeyJWK, 'X25519', true)
      && record.publicKeyJWK?.x === record.privateKeyJWK?.x
      && typeof record.createdAt === 'number'
      && Number.isFinite(record.createdAt),
  );
}

function jwkXToStandardBase64(x: string): string {
  const base64 = x.replace(/-/g, '+').replace(/_/g, '/');
  return base64 + '='.repeat((4 - (base64.length % 4)) % 4);
}

async function readDeviceRecords(userId: string, deviceId: string): Promise<{
  signing: StoredDeviceIdentityRecovery;
  kx: StoredDeviceKxRecovery;
}> {
  const signingId = signingStorageKey(userId, deviceId);
  const kxId = kxStorageKey(userId, deviceId);

  // Le coffre scellé fait autorité ; l'IndexedDB en clair n'est qu'un héritage.
  const [sealedSigning, sealedKx] = await Promise.all([
    readDeviceVaultRecord(signingId, (value): value is StoredDeviceIdentityRecovery =>
      validateSigningRecord(value, userId, deviceId)),
    readDeviceVaultRecord(kxId, (value): value is StoredDeviceKxRecovery =>
      validateKxRecord(value, userId, deviceId)),
  ]);
  if (sealedSigning && sealedKx) return { signing: sealedSigning, kx: sealedKx };

  const [signing, kx] = await runTx([STORE_KEYS], 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_KEYS);
    return Promise.all([
      reqToPromise(store.get(signingId)),
      reqToPromise(store.get(kxId)),
    ]);
  });
  const resolvedSigning = sealedSigning ?? signing;
  const resolvedKx = sealedKx ?? kx;
  if (!validateSigningRecord(resolvedSigning, userId, deviceId)) throw new Error('WEBAUTHN_DEVICE_SIGNING_KEYS_MISSING');
  if (!validateKxRecord(resolvedKx, userId, deviceId)) throw new Error('WEBAUTHN_DEVICE_KX_KEYS_MISSING');
  return { signing: resolvedSigning, kx: resolvedKx };
}


export async function captureEncryptedWebDeviceVault(
  userId: string,
  deviceId: string,
): Promise<EncryptedWebDeviceVault> {
  if (!userId || !DEVICE_ID_RE.test(deviceId)) throw new Error('WEBAUTHN_DEVICE_VAULT_SCOPE_INVALID');
  const masterKey = getSessionMasterKey();
  if (!masterKey) throw new Error('ACCOUNT_MASTER_KEY_REQUIRED');
  const { signing, kx } = await readDeviceRecords(userId, deviceId);
  const plain: PlainDeviceVault = {
    version: VAULT_VERSION,
    userId,
    deviceId,
    signing,
    kx,
    createdAt: Date.now(),
  };
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new hardGlobals.TextEncoder().encode(hardGlobals.jsonStringify(plain));
  const encrypted = await hardCrypto.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: aad(userId, deviceId).slice().buffer,
    tagLength: 128,
  }, masterKey, encoded);
  return {
    version: VAULT_VERSION,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(encrypted),
  };
}

export async function restoreEncryptedWebDeviceVault(args: {
  userId: string;
  deviceId: string;
  vault: EncryptedWebDeviceVault;
  expectedDeviceSigningKey: string;
  expectedDevicePublicKey: string;
}): Promise<void> {
  const { userId, deviceId, vault } = args;
  if (!userId || !DEVICE_ID_RE.test(deviceId) || vault.version !== VAULT_VERSION) {
    throw new Error('WEBAUTHN_DEVICE_VAULT_SCOPE_INVALID');
  }
  const masterKey = getSessionMasterKey();
  if (!masterKey) throw new Error('ACCOUNT_MASTER_KEY_REQUIRED');
  const iv = fromBase64Url(vault.iv);
  if (iv.byteLength !== IV_BYTES) throw new Error('WEBAUTHN_DEVICE_VAULT_IV_INVALID');
  const ciphertext = fromBase64Url(vault.ciphertext);
  let decoded: unknown;
  try {
    const plaintext = await hardCrypto.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: aad(userId, deviceId).slice().buffer,
      tagLength: 128,
    }, masterKey, ciphertext);
    decoded = hardGlobals.jsonParse(new hardGlobals.TextDecoder().decode(plaintext));
  } catch {
    throw new Error('WEBAUTHN_DEVICE_VAULT_DECRYPT_FAILED');
  }
  const plain = decoded as Partial<PlainDeviceVault> | null;
  if (!plain
    || plain.version !== VAULT_VERSION
    || plain.userId !== userId
    || plain.deviceId !== deviceId
    || !validateSigningRecord(plain.signing, userId, deviceId)
    || !validateKxRecord(plain.kx, userId, deviceId)) {
    throw new Error('WEBAUTHN_DEVICE_VAULT_INVALID');
  }
  if (jwkXToStandardBase64(plain.signing.publicKeyJWK.x!) !== args.expectedDeviceSigningKey
    || jwkXToStandardBase64(plain.kx.publicKeyJWK.x!) !== args.expectedDevicePublicKey) {
    throw new Error('WEBAUTHN_DEVICE_VAULT_KEY_MISMATCH');
  }
  await runTx([STORE_KEYS], 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_KEYS);
    store.put(plain.signing as object);
    store.put(plain.kx as object);
  });
}
