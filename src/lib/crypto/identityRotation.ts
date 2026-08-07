import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import {
  exportPublicKeyBundle,
  generateIdentityKeys,
  getOrCreateIdentityKeys,
  saveIdentityKeys,
  type IdentityKeyPair,
} from './keyManager';
import { loadDeviceIdentity, signDeviceAuthorization } from './deviceIdentity';
import { hardCrypto } from './cryptoIntegrity';
import {
  bufferToBase64,
  encodeString,
  exportKeyToJWK,
  importKeyFromJWK,
} from './utils';
import { KX_KEY_PARAMS, SIG_KEY_PARAMS, STORE_KEYS } from './constants';
import { txDelete, txGet, txPut } from './indexedDbTx';
import { clearAllDeviceSessions } from './deviceRatchet';
import {
  isAutoBackupActive,
  syncBackupToServer,
  syncKeychainSnapshotFromLocal,
} from './accountKeyBackup';
import {
  generateAndUploadDeviceSignedPrekey,
  refillDeviceOneTimePrekeysIfNeeded,
} from './x3dh';
import {
  attachIdentityRotationRecovery,
  fetchIdentityRotationRecovery,
  finalizeIdentityRotationRecovery,
  type IdentityRotationRecoveryPayload,
} from './identityRotationRecovery';

export type IdentityRotationReason =
  | 'manual_rotation'
  | 'suspected_compromise'
  | 'confirmed_compromise'
  | 'policy_rotation';

export interface IdentityRotationResult {
  rotationId: string;
  identityEpoch: number;
  fingerprint: string;
  survivingDeviceId: string;
  otherDevicesRevoked: true;
}

type ActiveIdentityRow = {
  fingerprint: string;
  identity_epoch: number;
};

type CurrentDeviceRow = {
  device_id: string;
  device_public_key: string;
  device_signing_key: string | null;
  approval_status: string;
  is_active: boolean;
  revoked_at: string | null;
  crypto_invalid_at: string | null;
};

type TrustedCurrentDevice = CurrentDeviceRow & {
  device_signing_key: string;
};

type BeginResponse = {
  ok: true;
  code: 'IDENTITY_ROTATION_CHALLENGE_CREATED';
  rotation_id: string;
  current_epoch: number;
  next_epoch: number;
  challenge_payload: string;
  expires_at: string;
};

type CommitResponse = {
  ok: true;
  code: 'IDENTITY_ROTATION_COMMITTED' | 'IDENTITY_ROTATION_ALREADY_COMMITTED';
  rotation_id: string;
  identity_epoch: number;
  fingerprint: string;
  surviving_device_id: string;
  other_devices_revoked: true;
};

type StatusResponse = {
  ok: true;
  rotation_id: string;
  status: 'pending' | 'committed' | 'cancelled' | 'expired';
  identity_epoch: number;
  fingerprint: string;
  approver_device_id: string;
  expires_at: string;
};

interface StagedIdentityRotation extends IdentityRotationRecoveryPayload {
  id: string;
}

const ROTATION_STAGE_PREFIX = 'identity-rotation-stage::';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

function stageId(userId: string): string {
  return `${ROTATION_STAGE_PREFIX}${userId}`;
}

function trustedCurrentDevice(row: CurrentDeviceRow | null): row is TrustedCurrentDevice {
  return Boolean(
    row &&
    row.approval_status === 'approved' &&
    row.is_active === true &&
    !row.revoked_at &&
    !row.crypto_invalid_at &&
    row.device_public_key &&
    row.device_signing_key,
  );
}

function assertBeginResponse(value: unknown): asserts value is BeginResponse {
  const candidate = value as Partial<BeginResponse> | null;
  const expiry = typeof candidate?.expires_at === 'string'
    ? Date.parse(candidate.expires_at)
    : Number.NaN;
  if (
    !candidate ||
    candidate.ok !== true ||
    candidate.code !== 'IDENTITY_ROTATION_CHALLENGE_CREATED' ||
    !candidate.rotation_id ||
    !UUID_RE.test(candidate.rotation_id) ||
    typeof candidate.current_epoch !== 'number' ||
    typeof candidate.next_epoch !== 'number' ||
    candidate.next_epoch !== candidate.current_epoch + 1 ||
    typeof candidate.challenge_payload !== 'string' ||
    candidate.challenge_payload.length < 100 ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now()
  ) {
    throw new Error('IDENTITY_ROTATION_INVALID_BEGIN_RESPONSE');
  }
}

function assertCommitResponse(value: unknown): asserts value is CommitResponse {
  const candidate = value as Partial<CommitResponse> | null;
  if (
    !candidate ||
    candidate.ok !== true ||
    !['IDENTITY_ROTATION_COMMITTED', 'IDENTITY_ROTATION_ALREADY_COMMITTED'].includes(
      String(candidate.code),
    ) ||
    !candidate.rotation_id ||
    !UUID_RE.test(candidate.rotation_id) ||
    typeof candidate.identity_epoch !== 'number' ||
    typeof candidate.fingerprint !== 'string' ||
    !DEVICE_ID_RE.test(String(candidate.surviving_device_id)) ||
    candidate.other_devices_revoked !== true
  ) {
    throw new Error('IDENTITY_ROTATION_INVALID_COMMIT_RESPONSE');
  }
}

function assertStatusResponse(value: unknown): asserts value is StatusResponse {
  const candidate = value as Partial<StatusResponse> | null;
  if (
    !candidate ||
    candidate.ok !== true ||
    !candidate.rotation_id ||
    !UUID_RE.test(candidate.rotation_id) ||
    !['pending', 'committed', 'cancelled', 'expired'].includes(String(candidate.status)) ||
    typeof candidate.identity_epoch !== 'number' ||
    typeof candidate.fingerprint !== 'string' ||
    !DEVICE_ID_RE.test(String(candidate.approver_device_id))
  ) {
    throw new Error('IDENTITY_ROTATION_INVALID_STATUS_RESPONSE');
  }
}

async function signPayload(privateKey: CryptoKey, payload: string): Promise<string> {
  return bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    privateKey,
    encodeString(payload),
  ) as ArrayBuffer);
}

async function createStage(args: {
  userId: string;
  rotationId: string;
  currentEpoch: number;
  nextEpoch: number;
  keys: IdentityKeyPair;
  fingerprint: string;
  expiresAt: string;
}): Promise<StagedIdentityRotation> {
  if (!args.keys._privJWK || !args.keys._sigPrivJWK) {
    throw new Error('IDENTITY_ROTATION_PRIVATE_STAGE_UNAVAILABLE');
  }
  const [publicKeyJWK, signingPublicKeyJWK] = await Promise.all([
    exportKeyToJWK(args.keys.publicKey),
    exportKeyToJWK(args.keys.signingPublicKey),
  ]);
  const record: StagedIdentityRotation = {
    id: stageId(args.userId),
    userId: args.userId,
    rotationId: args.rotationId,
    currentEpoch: args.currentEpoch,
    nextEpoch: args.nextEpoch,
    fingerprint: args.fingerprint,
    publicKeyJWK,
    privateKeyJWK: args.keys._privJWK,
    signingPublicKeyJWK,
    signingPrivateKeyJWK: args.keys._sigPrivJWK,
    createdAt: args.keys.createdAt,
    expiresAt: args.expiresAt,
  };
  await txPut(STORE_KEYS, record);
  return record;
}

async function persistRecoveredStage(
  userId: string,
  payload: IdentityRotationRecoveryPayload,
): Promise<StagedIdentityRotation> {
  const record: StagedIdentityRotation = {
    ...payload,
    id: stageId(userId),
  };
  await txPut(STORE_KEYS, record);
  return record;
}

async function loadStage(userId: string): Promise<{
  record: StagedIdentityRotation;
  keys: IdentityKeyPair;
} | null> {
  const record = await txGet<StagedIdentityRotation>(STORE_KEYS, stageId(userId));
  if (!record || record.id !== stageId(userId) || record.userId !== userId) return null;
  if (!UUID_RE.test(record.rotationId) || record.nextEpoch !== record.currentEpoch + 1) {
    throw new Error('IDENTITY_ROTATION_STAGE_INVALID');
  }

  const [publicKey, privateKey, signingPublicKey, signingPrivateKey] = await Promise.all([
    importKeyFromJWK(record.publicKeyJWK, KX_KEY_PARAMS, [], true),
    importKeyFromJWK(record.privateKeyJWK, KX_KEY_PARAMS, ['deriveBits'], false),
    importKeyFromJWK(record.signingPublicKeyJWK, SIG_KEY_PARAMS, ['verify'], true),
    importKeyFromJWK(record.signingPrivateKeyJWK, SIG_KEY_PARAMS, ['sign'], false),
  ]);
  return {
    record,
    keys: {
      publicKey,
      privateKey,
      signingPublicKey,
      signingPrivateKey,
      createdAt: record.createdAt,
      fingerprint: record.fingerprint,
      _privJWK: record.privateKeyJWK,
      _sigPrivJWK: record.signingPrivateKeyJWK,
    },
  };
}

async function promoteStage(userId: string, expected: {
  rotationId: string;
  epoch: number;
  fingerprint: string;
}): Promise<void> {
  const staged = await loadStage(userId);
  if (
    !staged ||
    staged.record.rotationId !== expected.rotationId ||
    staged.record.nextEpoch !== expected.epoch ||
    staged.record.fingerprint !== expected.fingerprint
  ) {
    throw new Error('IDENTITY_ROTATION_COMMITTED_STAGE_MISMATCH');
  }

  await saveIdentityKeys(userId, staged.keys);

  const backupSynced = await syncBackupToServer();
  if (!backupSynced) {
    throw new Error('IDENTITY_ROTATION_BACKUP_SYNC_REQUIRED');
  }

  const deviceId = getCurrentDeviceId();
  const deviceIdentity = await loadDeviceIdentity(userId, deviceId);
  if (!deviceIdentity) throw new Error('IDENTITY_ROTATION_DEVICE_PRIVATE_KEY_REQUIRED');

  await generateAndUploadDeviceSignedPrekey(
    userId,
    deviceId,
    deviceIdentity.privateKey,
  );
  await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);
  await clearAllDeviceSessions();
  await txDelete(STORE_KEYS, stageId(userId));
  await syncKeychainSnapshotFromLocal(userId).catch(() => false);
  await finalizeIdentityRotationRecovery(expected.rotationId).catch(() => undefined);

  try {
    window.dispatchEvent(new CustomEvent('forsure-identity-rotated', {
      detail: {
        rotationId: expected.rotationId,
        identityEpoch: expected.epoch,
        fingerprint: expected.fingerprint,
      },
    }));
  } catch {
    // SSR or non-window runtime.
  }
}

async function invokeRotation<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('identity-rotation', { body });
  if (error) throw new Error(`IDENTITY_ROTATION_EDGE_FAILED:${error.message}`);
  return data as T;
}

/**
 * Rotate the stable account X25519 + Ed25519 identity.
 *
 * This function must only be called from an explicit, high-friction user
 * action. It never runs from recovery, hydration, retry or background sync.
 * The current approved device survives; every other device is revoked and must
 * be enrolled again under the new account identity.
 */
export async function rotateAccountIdentity(
  reason: IdentityRotationReason,
): Promise<IdentityRotationResult> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData.user;
  if (userError || !user) throw new Error('IDENTITY_ROTATION_NOT_AUTHENTICATED');
  if (!isAutoBackupActive()) {
    throw new Error('IDENTITY_ROTATION_UNLOCKED_BACKUP_REQUIRED');
  }

  const deviceId = getCurrentDeviceId();
  if (!DEVICE_ID_RE.test(deviceId)) throw new Error('IDENTITY_ROTATION_SERVER_DEVICE_REQUIRED');

  const [currentKeys, deviceIdentity, currentResult, deviceResult] = await Promise.all([
    getOrCreateIdentityKeys(user.id),
    loadDeviceIdentity(user.id, deviceId),
    supabase
      .from('user_public_keys')
      .select('fingerprint,identity_epoch' as never)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('user_devices')
      .select('device_id,device_public_key,device_signing_key,approval_status,is_active,revoked_at,crypto_invalid_at')
      .eq('user_id', user.id)
      .eq('device_id', deviceId)
      .maybeSingle(),
  ]);

  const current = currentResult.data as unknown as ActiveIdentityRow | null;
  const currentDevice = deviceResult.data as CurrentDeviceRow | null;
  if (currentResult.error || !current || current.identity_epoch < 1) {
    throw new Error('IDENTITY_ROTATION_CURRENT_IDENTITY_NOT_FOUND');
  }
  if (!deviceIdentity || deviceIdentity.publicB64 !== currentDevice?.device_signing_key) {
    throw new Error('IDENTITY_ROTATION_DEVICE_PRIVATE_KEY_REQUIRED');
  }
  if (deviceResult.error || !trustedCurrentDevice(currentDevice)) {
    throw new Error('IDENTITY_ROTATION_APPROVER_NOT_TRUSTED');
  }

  const currentBundle = await exportPublicKeyBundle(currentKeys);
  if (currentBundle.fingerprint !== current.fingerprint) {
    throw new Error('IDENTITY_ROTATION_LOCAL_SERVER_IDENTITY_MISMATCH');
  }

  const proposedKeys = await generateIdentityKeys();
  const proposedBundle = await exportPublicKeyBundle(proposedKeys);
  if (proposedBundle.fingerprint === current.fingerprint) {
    throw new Error('IDENTITY_ROTATION_FINGERPRINT_UNCHANGED');
  }

  const begin = await invokeRotation<BeginResponse>({
    action: 'begin',
    current_epoch: current.identity_epoch,
    current_fingerprint: current.fingerprint,
    proposed_identity_key: proposedBundle.identityKey,
    proposed_signing_key: proposedBundle.signingKey,
    proposed_fingerprint: proposedBundle.fingerprint,
    proposed_binding_signature: proposedBundle.bindingSignature,
    approver_device_id: deviceId,
    reason,
  });
  assertBeginResponse(begin);

  try {
    const staged = await createStage({
      userId: user.id,
      rotationId: begin.rotation_id,
      currentEpoch: begin.current_epoch,
      nextEpoch: begin.next_epoch,
      keys: proposedKeys,
      fingerprint: proposedBundle.fingerprint,
      expiresAt: begin.expires_at,
    });
    await attachIdentityRotationRecovery(staged);
  } catch (error) {
    await invokeRotation<Record<string, unknown>>({
      action: 'cancel',
      rotation_id: begin.rotation_id,
    }).catch(() => undefined);
    await txDelete(STORE_KEYS, stageId(user.id)).catch(() => undefined);
    throw error;
  }

  const [oldIdentitySignature, approverSignature, currentDeviceAuthorizationSignature] = await Promise.all([
    signPayload(currentKeys.signingPrivateKey, begin.challenge_payload),
    signPayload(deviceIdentity.privateKey, begin.challenge_payload),
    signDeviceAuthorization({
      userId: user.id,
      deviceId,
      accountFingerprint: proposedBundle.fingerprint,
      devicePublicKey: currentDevice.device_public_key,
      deviceSigningKey: currentDevice.device_signing_key,
      accountSigningPrivateKey: proposedKeys.signingPrivateKey,
    }),
  ]);

  const committed = await invokeRotation<CommitResponse>({
    action: 'commit',
    rotation_id: begin.rotation_id,
    old_identity_signature: oldIdentitySignature,
    approver_signature: approverSignature,
    current_device_authorization_signature: currentDeviceAuthorizationSignature,
  });
  assertCommitResponse(committed);

  try {
    await promoteStage(user.id, {
      rotationId: committed.rotation_id,
      epoch: committed.identity_epoch,
      fingerprint: committed.fingerprint,
    });
  } catch {
    throw new Error('IDENTITY_ROTATION_COMMITTED_LOCAL_PROMOTION_PENDING');
  }

  return {
    rotationId: committed.rotation_id,
    identityEpoch: committed.identity_epoch,
    fingerprint: committed.fingerprint,
    survivingDeviceId: committed.surviving_device_id,
    otherDevicesRevoked: true,
  };
}

/**
 * Complete local promotion after the server committed but the app crashed or
 * storage was temporarily unavailable. Safe to call after the account backup
 * has been unlocked; it never starts a new rotation.
 */
export async function recoverPendingIdentityRotation(): Promise<boolean> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData.user;
  if (userError || !user || !isAutoBackupActive()) return false;

  let staged = await loadStage(user.id);
  if (!staged) {
    const recovered = await fetchIdentityRotationRecovery(user.id);
    if (!recovered) return false;
    await persistRecoveredStage(user.id, recovered);
    staged = await loadStage(user.id);
  }
  if (!staged) return false;

  const status = await invokeRotation<StatusResponse>({
    action: 'status',
    rotation_id: staged.record.rotationId,
  });
  assertStatusResponse(status);

  if (status.status === 'cancelled' || status.status === 'expired') {
    await txDelete(STORE_KEYS, stageId(user.id));
    return false;
  }
  if (status.status !== 'committed') return false;

  await promoteStage(user.id, {
    rotationId: status.rotation_id,
    epoch: status.identity_epoch,
    fingerprint: status.fingerprint,
  });
  return true;
}

export async function cancelPendingIdentityRotation(): Promise<boolean> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData.user;
  if (userError || !user) return false;
  const staged = await loadStage(user.id);
  if (!staged) return false;

  await invokeRotation<Record<string, unknown>>({
    action: 'cancel',
    rotation_id: staged.record.rotationId,
  });
  await txDelete(STORE_KEYS, stageId(user.id));
  return true;
}

export async function hasPendingIdentityRotation(): Promise<boolean> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData.user;
  if (userError || !user) return false;
  return Boolean(await txGet<StagedIdentityRotation>(STORE_KEYS, stageId(user.id)));
}
