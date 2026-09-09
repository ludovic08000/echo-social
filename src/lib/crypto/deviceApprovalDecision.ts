import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { bufferToBase64, encodeString } from '@/lib/crypto/utils';

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

  const { data, error } = await supabase.rpc('approve_device_enrollment_decision' as never, {
    p_decision: 'approve',
    p_bootstrap_primary: true,
    p_approver_device_id: args.target.deviceId,
    p_device_id: args.target.deviceId,
    p_challenge_id: args.target.challengeId,
    p_signature: signature,
    p_device_authorization_signature: null,
  } as never);

  if (error) throw new Error(`DEVICE_APPROVAL_RPC_FAILED:${error.message}`);
  const result = data as Record<string, unknown> | null;
  if (!result) throw new Error('DEVICE_APPROVAL_RPC_EMPTY_RESPONSE');
  if (result.ok !== true || result.code !== 'DEVICE_APPROVED' || result.device_id !== args.target.deviceId) {
    throw new Error(typeof result.code === 'string' ? result.code : 'DEVICE_AUTO_APPROVAL_REJECTED');
  }
  return { deviceId: args.target.deviceId, decision: 'approve' };
}
