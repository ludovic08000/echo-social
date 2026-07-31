import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from './utils';

export const AEGIS_RECOVERY_PROTOCOL = 'aegis-recovery-v1';
export const AEGIS_RECOVERY_VERSION = 1;
const RECOVERY_KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;

export interface PortableAccountIdentity {
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  signingPublicKeyJWK: JsonWebKey;
  signingPrivateKeyJWK: JsonWebKey;
  createdAt: number;
  fingerprint: string;
}

export interface AegisRecoveryVaultPayload {
  protocol: typeof AEGIS_RECOVERY_PROTOCOL;
  version: typeof AEGIS_RECOVERY_VERSION;
  userId: string;
  generation: number;
  createdAt: string;
  identity: PortableAccountIdentity;
}

export interface AegisRecoveryVaultEnvelope {
  protocolVersion: typeof AEGIS_RECOVERY_VERSION;
  generation: number;
  identityFingerprint: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

export type RecoveryInstallDecision = 'install' | 'already_present' | 'conflict';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out as Uint8Array<ArrayBuffer>;
}

export function normalizeAegisRecoveryKey(input: string): string {
  return input.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

export function isValidAegisRecoveryKey(input: string): boolean {
  return /^[A-F0-9]{64}$/.test(normalizeAegisRecoveryKey(input));
}

export function generateAegisRecoveryKey(): string {
  const raw = hardCrypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  return bytesToHex(raw).match(/.{1,4}/g)?.join('-') ?? bytesToHex(raw);
}

export function nextRecoveryGeneration(current: number | null | undefined): number {
  if (current == null) return 1;
  if (!Number.isSafeInteger(current) || current < 1) throw new Error('INVALID_RECOVERY_GENERATION');
  return current + 1;
}

function canonicalAad(args: {
  userId: string;
  generation: number;
  identityFingerprint: string;
}): Uint8Array<ArrayBuffer> {
  return new hardGlobals.TextEncoder().encode(JSON.stringify({
    protocol: AEGIS_RECOVERY_PROTOCOL,
    version: AEGIS_RECOVERY_VERSION,
    userId: args.userId,
    generation: args.generation,
    identityFingerprint: args.identityFingerprint,
  })) as Uint8Array<ArrayBuffer>;
}

async function deriveVaultKey(
  recoveryKey: string,
  salt: Uint8Array<ArrayBuffer>,
  userId: string,
  generation: number,
): Promise<CryptoKey> {
  const normalized = normalizeAegisRecoveryKey(recoveryKey);
  if (!isValidAegisRecoveryKey(normalized)) throw new Error('INVALID_RECOVERY_KEY');
  const material = await hardCrypto.importKey('raw', hexToBytes(normalized), 'HKDF', false, ['deriveKey']);
  const info = new hardGlobals.TextEncoder().encode(
    `${AEGIS_RECOVERY_PROTOCOL}:${userId}:${generation}`,
  );
  return hardCrypto.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealAegisRecoveryVault(
  payload: AegisRecoveryVaultPayload,
  recoveryKey: string,
): Promise<AegisRecoveryVaultEnvelope> {
  if (payload.protocol !== AEGIS_RECOVERY_PROTOCOL || payload.version !== AEGIS_RECOVERY_VERSION) {
    throw new Error('INVALID_RECOVERY_PAYLOAD_VERSION');
  }
  if (!Number.isSafeInteger(payload.generation) || payload.generation < 1) {
    throw new Error('INVALID_RECOVERY_GENERATION');
  }
  const salt = hardCrypto.getRandomValues(new Uint8Array(SALT_BYTES)) as Uint8Array<ArrayBuffer>;
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_BYTES)) as Uint8Array<ArrayBuffer>;
  const key = await deriveVaultKey(recoveryKey, salt, payload.userId, payload.generation);
  const ciphertext = await hardCrypto.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: canonicalAad({
        userId: payload.userId,
        generation: payload.generation,
        identityFingerprint: payload.identity.fingerprint,
      }),
      tagLength: 128,
    },
    key,
    new hardGlobals.TextEncoder().encode(JSON.stringify(payload)),
  );
  return {
    protocolVersion: AEGIS_RECOVERY_VERSION,
    generation: payload.generation,
    identityFingerprint: payload.identity.fingerprint,
    salt: bufferToBase64(salt.buffer),
    iv: bufferToBase64(iv.buffer),
    ciphertext: bufferToBase64(ciphertext),
  };
}

export async function openAegisRecoveryVault(args: {
  envelope: AegisRecoveryVaultEnvelope;
  recoveryKey: string;
  userId: string;
}): Promise<AegisRecoveryVaultPayload> {
  const { envelope, recoveryKey, userId } = args;
  if (envelope.protocolVersion !== AEGIS_RECOVERY_VERSION) throw new Error('UNSUPPORTED_RECOVERY_VERSION');
  const salt = new Uint8Array(base64ToBuffer(envelope.salt)) as Uint8Array<ArrayBuffer>;
  const iv = new Uint8Array(base64ToBuffer(envelope.iv)) as Uint8Array<ArrayBuffer>;
  const key = await deriveVaultKey(recoveryKey, salt, userId, envelope.generation);
  const plaintext = await hardCrypto.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: canonicalAad({
        userId,
        generation: envelope.generation,
        identityFingerprint: envelope.identityFingerprint,
      }),
      tagLength: 128,
    },
    key,
    base64ToBuffer(envelope.ciphertext),
  );
  const payload = JSON.parse(new hardGlobals.TextDecoder().decode(plaintext)) as AegisRecoveryVaultPayload;
  if (
    payload.protocol !== AEGIS_RECOVERY_PROTOCOL ||
    payload.version !== AEGIS_RECOVERY_VERSION ||
    payload.userId !== userId ||
    payload.generation !== envelope.generation ||
    payload.identity?.fingerprint !== envelope.identityFingerprint
  ) {
    throw new Error('RECOVERY_METADATA_MISMATCH');
  }
  return payload;
}

export function decideRecoveryInstall(args: {
  vaultFingerprint: string;
  localFingerprint?: string | null;
  serverFingerprint?: string | null;
}): RecoveryInstallDecision {
  if (args.serverFingerprint && args.serverFingerprint !== args.vaultFingerprint) return 'conflict';
  if (!args.localFingerprint) return 'install';
  return args.localFingerprint === args.vaultFingerprint ? 'already_present' : 'conflict';
}
