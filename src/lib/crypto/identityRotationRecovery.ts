import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { getSessionMasterKey } from './accountKeyBackup';
import { loadDeviceIdentity } from './deviceIdentity';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from './utils';

export interface IdentityRotationRecoveryPayload {
  userId: string;
  rotationId: string;
  currentEpoch: number;
  nextEpoch: number;
  fingerprint: string;
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  signingPublicKeyJWK: JsonWebKey;
  signingPrivateKeyJWK: JsonWebKey;
  createdAt: number;
  expiresAt: string;
}

type RecoveryFetchResponse = {
  ok: true;
  code: 'IDENTITY_ROTATION_RECOVERY_AVAILABLE';
  rotation_id: string;
  identity_epoch: number;
  fingerprint: string;
  surviving_device_id: string;
  recovery_blob: string;
  recovery_iv: string;
  recovery_blob_version: number;
};

type RecoveryAction = 'attach' | 'fetch' | 'finalize';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const IV_BYTES = 12;

function recoveryAAD(userId: string, rotationId: string, fingerprint: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(
    `forsure-aegis-identity-rotation-recovery-v1|${userId}|${rotationId}|${fingerprint}`,
  );
}

function validatePayload(
  payload: IdentityRotationRecoveryPayload,
  expected?: { userId: string; rotationId: string; epoch: number; fingerprint: string },
): void {
  if (
    !UUID_RE.test(payload.userId) ||
    !UUID_RE.test(payload.rotationId) ||
    payload.currentEpoch < 1 ||
    payload.nextEpoch !== payload.currentEpoch + 1 ||
    typeof payload.fingerprint !== 'string' ||
    payload.fingerprint.length < 20 ||
    !payload.publicKeyJWK ||
    !payload.privateKeyJWK ||
    !payload.signingPublicKeyJWK ||
    !payload.signingPrivateKeyJWK ||
    !Number.isFinite(payload.createdAt) ||
    !Number.isFinite(Date.parse(payload.expiresAt))
  ) {
    throw new Error('IDENTITY_ROTATION_RECOVERY_PAYLOAD_INVALID');
  }
  if (expected && (
    payload.userId !== expected.userId ||
    payload.rotationId !== expected.rotationId ||
    payload.nextEpoch !== expected.epoch ||
    payload.fingerprint !== expected.fingerprint
  )) {
    throw new Error('IDENTITY_ROTATION_RECOVERY_CONTEXT_MISMATCH');
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(await hardCrypto.digest(
      'SHA-256',
      new hardGlobals.TextEncoder().encode(value),
    )),
  );
}

function accessProofPayload(args: {
  action: RecoveryAction;
  userId: string;
  deviceId: string;
  rotationId: string | null;
  issuedAt: string;
  recoveryDigest: string | null;
}): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-identity-rotation-recovery-access',
    version: 1,
    action: args.action,
    userId: args.userId,
    deviceId: args.deviceId,
    rotationId: args.rotationId,
    issuedAt: args.issuedAt,
    recoveryDigest: args.recoveryDigest,
  });
}

async function createAccessProof(args: {
  action: RecoveryAction;
  userId: string;
  rotationId: string | null;
  recoveryBlob?: string;
  recoveryIv?: string;
  recoveryVersion?: number;
}): Promise<{
  device_id: string;
  proof_issued_at: string;
  proof_signature: string;
}> {
  const deviceId = getCurrentDeviceId();
  if (!DEVICE_ID_RE.test(deviceId)) {
    throw new Error('IDENTITY_ROTATION_RECOVERY_SERVER_DEVICE_REQUIRED');
  }
  const deviceIdentity = await loadDeviceIdentity(args.userId, deviceId);
  if (!deviceIdentity) {
    throw new Error('IDENTITY_ROTATION_RECOVERY_DEVICE_PRIVATE_KEY_REQUIRED');
  }

  const issuedAt = new Date().toISOString();
  const recoveryDigest = args.action === 'attach'
    ? await sha256Base64Url(JSON.stringify({
      recoveryBlob: args.recoveryBlob,
      recoveryIv: args.recoveryIv,
      recoveryVersion: args.recoveryVersion,
    }))
    : null;
  const signature = await hardCrypto.sign(
    'Ed25519',
    deviceIdentity.privateKey,
    new hardGlobals.TextEncoder().encode(accessProofPayload({
      action: args.action,
      userId: args.userId,
      deviceId,
      rotationId: args.rotationId,
      issuedAt,
      recoveryDigest,
    })),
  ) as ArrayBuffer;

  return {
    device_id: deviceId,
    proof_issued_at: issuedAt,
    proof_signature: bufferToBase64(signature),
  };
}

async function invokeRecovery<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('identity-rotation-recovery', { body });
  if (error) throw new Error(`IDENTITY_ROTATION_RECOVERY_EDGE_FAILED:${error.message}`);
  return data as T;
}

export async function attachIdentityRotationRecovery(
  payload: IdentityRotationRecoveryPayload,
): Promise<void> {
  validatePayload(payload);
  const masterKey = getSessionMasterKey();
  if (!masterKey) throw new Error('IDENTITY_ROTATION_MASTER_KEY_REQUIRED');

  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new hardGlobals.TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await hardCrypto.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: recoveryAAD(payload.userId, payload.rotationId, payload.fingerprint),
    },
    masterKey,
    plaintext,
  );
  const recoveryBlob = bufferToBase64(ciphertext);
  const recoveryIv = bufferToBase64(iv.buffer);
  const recoveryVersion = 1;
  const proof = await createAccessProof({
    action: 'attach',
    userId: payload.userId,
    rotationId: payload.rotationId,
    recoveryBlob,
    recoveryIv,
    recoveryVersion,
  });

  await invokeRecovery<Record<string, unknown>>({
    action: 'attach',
    rotation_id: payload.rotationId,
    recovery_blob: recoveryBlob,
    recovery_iv: recoveryIv,
    recovery_blob_version: recoveryVersion,
    ...proof,
  });
}

export async function fetchIdentityRotationRecovery(
  userId: string,
): Promise<IdentityRotationRecoveryPayload | null> {
  const masterKey = getSessionMasterKey();
  if (!masterKey) return null;

  const proof = await createAccessProof({
    action: 'fetch',
    userId,
    rotationId: null,
  });
  let response: RecoveryFetchResponse;
  try {
    response = await invokeRecovery<RecoveryFetchResponse>({
      action: 'fetch',
      ...proof,
    });
  } catch {
    return null;
  }
  if (
    response.ok !== true ||
    response.code !== 'IDENTITY_ROTATION_RECOVERY_AVAILABLE' ||
    !UUID_RE.test(response.rotation_id) ||
    response.identity_epoch < 2 ||
    typeof response.fingerprint !== 'string' ||
    !DEVICE_ID_RE.test(response.surviving_device_id) ||
    response.surviving_device_id !== proof.device_id ||
    response.recovery_blob_version !== 1
  ) {
    throw new Error('IDENTITY_ROTATION_RECOVERY_RESPONSE_INVALID');
  }

  const iv = new Uint8Array(base64ToBuffer(response.recovery_iv));
  if (iv.byteLength !== IV_BYTES) throw new Error('IDENTITY_ROTATION_RECOVERY_IV_INVALID');
  const plaintext = await hardCrypto.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: recoveryAAD(userId, response.rotation_id, response.fingerprint),
    },
    masterKey,
    base64ToBuffer(response.recovery_blob),
  );
  const parsed = JSON.parse(new hardGlobals.TextDecoder().decode(plaintext)) as IdentityRotationRecoveryPayload;
  validatePayload(parsed, {
    userId,
    rotationId: response.rotation_id,
    epoch: response.identity_epoch,
    fingerprint: response.fingerprint,
  });
  return parsed;
}

export async function hasRemoteIdentityRotationRecovery(): Promise<boolean> {
  const { data, error } = await supabase.auth.getUser();
  const user = data.user;
  if (error || !user || !getSessionMasterKey()) return false;
  return Boolean(await fetchIdentityRotationRecovery(user.id).catch(() => null));
}

export async function finalizeIdentityRotationRecovery(
  rotationId: string,
  explicitUserId?: string,
): Promise<void> {
  if (!UUID_RE.test(rotationId)) throw new Error('IDENTITY_ROTATION_ID_INVALID');
  let userId = explicitUserId;
  if (!userId) {
    const { data, error } = await supabase.auth.getUser();
    userId = error ? undefined : data.user?.id;
  }
  if (!userId || !UUID_RE.test(userId)) {
    throw new Error('IDENTITY_ROTATION_NOT_AUTHENTICATED');
  }
  const proof = await createAccessProof({
    action: 'finalize',
    userId,
    rotationId,
  });
  await invokeRecovery<Record<string, unknown>>({
    action: 'finalize',
    rotation_id: rotationId,
    ...proof,
  });
}
