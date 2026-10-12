import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import {
  loadDeviceIdentity,
  signDeviceAuthorization,
} from '@/lib/crypto/deviceIdentity';
import { loadDeviceKxKey } from './deviceKx';
import { exportPublicKeyBundle, loadIdentityKeys, PinUnlockRequiredError } from './keyManager';
import { inspectAccountCryptoState } from './accountCryptoState';
import { DeviceApprovalRecoveryRequiredError, type DeviceApprovalPrerequisite } from '@/lib/device-manager/deviceApprovalPrerequisite';
import { bufferToBase64, encodeString } from '@/lib/crypto/utils';
import { runDeviceRpcWithTimeout } from '@/lib/api/deviceRpcTimeout';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeviceApprovalDecision = 'approve' | 'reject';

export interface PendingDeviceApprovalTarget {
  deviceId: string;
  challengeId: string;
  devicePublicKey: string;
  deviceSigningKey: string;
}

export function canonicalDeviceApprovalDecisionPayload(args: {
  userId: string;
  approverDeviceId: string;
  target: PendingDeviceApprovalTarget;
  decision: DeviceApprovalDecision;
}): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-device-approval-decision',
    userId: args.userId,
    approverDeviceId: args.approverDeviceId,
    deviceId: args.target.deviceId,
    challengeId: args.target.challengeId,
    devicePublicKey: args.target.devicePublicKey,
    deviceSigningKey: args.target.deviceSigningKey,
    decision: args.decision,
  });
}

function validateTarget(target: PendingDeviceApprovalTarget): void {
  if (!DEVICE_ID_RE.test(target.deviceId)) throw new Error('DEVICE_APPROVAL_INVALID_DEVICE_ID');
  if (!UUID_RE.test(target.challengeId)) throw new Error('DEVICE_APPROVAL_INVALID_CHALLENGE_ID');
}

async function readApprovalMode(deviceId: string): Promise<boolean> {
  const { data, error } = await runDeviceRpcWithTimeout('DEVICE_APPROVAL_MODE_FAILED',
    (signal) => supabase.rpc('get_device_enrollment_approval_mode' as never, {
      p_device_id: deviceId,
    } as never).abortSignal(signal));
  if (error) throw new Error(`DEVICE_APPROVAL_MODE_FAILED:${error.message}`);
  const mode = data as Record<string, unknown> | null;
  if (!mode || mode.ok !== true || typeof mode.bootstrap_primary !== 'boolean') {
    throw new Error(typeof mode?.code === 'string' ? mode.code : 'DEVICE_APPROVAL_MODE_REJECTED');
  }
  return mode.bootstrap_primary;
}

async function loadApprovalAccountKeys(userId: string) {
  try {
    const keys = await loadIdentityKeys(userId);
    if (keys) return keys;
  } catch (error) {
    if (!(error instanceof PinUnlockRequiredError)) throw error;
  }
  throw new DeviceApprovalRecoveryRequiredError();
}

export async function inspectAutomaticDeviceApproval(userId: string, deviceId: string): Promise<DeviceApprovalPrerequisite> {
  if (await readApprovalMode(deviceId)) return 'ready';
  const account = await inspectAccountCryptoState(userId);
  if (account.state !== 'READY') return 'account_recovery_required';
  try {
    await loadApprovalAccountKeys(userId);
    return 'ready';
  } catch (error) {
    if (error instanceof DeviceApprovalRecoveryRequiredError) return 'account_recovery_required';
    throw error;
  }
}

/**
 * Invariant cryptographique modifié : l'approbation manuelle par un second
 * appareil est supprimée. L'appareil courant signe lui-même sa décision avec
 * sa clé Ed25519 locale ; le serveur reste le seul à écrire l'état `approved`,
 * après vérification de la signature, de la preuve de possession du challenge
 * exact et de la propriété user_id/device_id. Aucun statut client n'est cru.
 */
export async function submitAutomaticDeviceApproval(args: {
  userId: string;
  target: PendingDeviceApprovalTarget;
}): Promise<{ deviceId: string; decision: 'approve' }> {
  if (!args.userId) throw new Error('DEVICE_APPROVAL_USER_REQUIRED');
  validateTarget(args.target);

  const identity = await loadDeviceIdentity(args.userId, args.target.deviceId);
  if (!identity || identity.publicB64 !== args.target.deviceSigningKey) {
    throw new Error('DEVICE_AUTO_APPROVAL_LOCAL_IDENTITY_INVALID');
  }

  // Le serveur est l'unique autorité pour décider si ce device est réellement
  // le premier. Un ancien client ne peut plus forcer le bootstrap en envoyant
  // `true`. Pour un appareil secondaire, la clé racine Aegis doit en plus
  // autoriser explicitement les deux clés publiques de l'appareil.
  const bootstrapPrimary = await readApprovalMode(args.target.deviceId);

  let deviceAuthorizationSignature: string | null = null;
  if (!bootstrapPrimary) {
    // Autoriser un appareil existant ne crée ni ne remplace aucune clé.
    const accountKeys = await loadApprovalAccountKeys(args.userId);
    const account = await exportPublicKeyBundle(accountKeys);
    const kx = await loadDeviceKxKey(args.target.deviceId, args.userId);
    if (!kx || kx.publicB64 !== args.target.devicePublicKey) {
      throw new Error('DEVICE_AUTHORIZATION_LOCAL_KEY_MISMATCH');
    }
    deviceAuthorizationSignature = await signDeviceAuthorization({
      userId: args.userId,
      deviceId: args.target.deviceId,
      accountFingerprint: account.fingerprint,
      accountSigningPrivateKey: accountKeys.signingPrivateKey,
      devicePublicKey: kx.publicB64,
      deviceSigningKey: identity.publicB64,
    });
  }

  const signature = bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    identity.privateKey,
    encodeString(canonicalDeviceApprovalDecisionPayload({
      userId: args.userId,
      approverDeviceId: args.target.deviceId,
      target: args.target,
      decision: 'approve',
    })),
  ) as ArrayBuffer);

  const { data, error } = await runDeviceRpcWithTimeout(
    'DEVICE_APPROVAL_RPC_FAILED',
    (signal) => supabase.rpc('approve_device_enrollment_decision' as never, {
      p_decision: 'approve',
      p_bootstrap_primary: bootstrapPrimary,
      p_approver_device_id: args.target.deviceId,
      p_device_id: args.target.deviceId,
      p_challenge_id: args.target.challengeId,
      p_signature: signature,
      p_device_authorization_signature: deviceAuthorizationSignature,
    } as never).abortSignal(signal),
  );

  if (error) throw new Error(`DEVICE_APPROVAL_RPC_FAILED:${error.message}`);
  const result = data as Record<string, unknown> | null;
  if (!result) throw new Error('DEVICE_APPROVAL_RPC_EMPTY_RESPONSE');
  if (result.ok !== true || result.code !== 'DEVICE_APPROVED' || result.device_id !== args.target.deviceId) {
    throw new Error(typeof result.code === 'string' ? result.code : 'DEVICE_AUTO_APPROVAL_REJECTED');
  }
  return { deviceId: args.target.deviceId, decision: 'approve' };
}
