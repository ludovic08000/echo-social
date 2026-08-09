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

type ApprovalPayloadArgs = {
  userId: string;
  approverDeviceId: string;
  target: PendingDeviceApprovalTarget;
  decision: DeviceApprovalDecision;
  selfApproval?: boolean;
};

export function canonicalDeviceApprovalDecisionPayload(args: ApprovalPayloadArgs): string {
  const payload = {
    protocol: 'forsure-aegis-device-approval-decision',
    version: 1,
    userId: args.userId,
    approverDeviceId: args.approverDeviceId,
    targetDeviceId: args.target.deviceId,
    targetChallengeId: args.target.challengeId,
    targetDevicePublicKey: args.target.devicePublicKey,
    targetDeviceSigningKey: args.target.deviceSigningKey,
    decision: args.decision,
  };
  return JSON.stringify(args.selfApproval === true
    ? { ...payload, selfApproval: true }
    : payload);
}

function validateTarget(target: PendingDeviceApprovalTarget): void {
  if (!DEVICE_ID_RE.test(target.deviceId)) throw new Error('DEVICE_APPROVAL_INVALID_DEVICE_ID');
  if (!UUID_RE.test(target.challengeId)) throw new Error('DEVICE_APPROVAL_INVALID_CHALLENGE_ID');
}

async function invokeApproval(args: ApprovalPayloadArgs): Promise<{ deviceId: string; decision: DeviceApprovalDecision }> {
  const approverIdentity = await loadDeviceIdentity(args.userId, args.approverDeviceId);
  if (!approverIdentity) throw new Error('DEVICE_APPROVER_PRIVATE_KEY_MISSING');

  if (args.selfApproval === true && approverIdentity.publicB64 !== args.target.deviceSigningKey) {
    throw new Error('DEVICE_SELF_APPROVAL_KEY_MISMATCH');
  }

  const approvalSignature = bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    approverIdentity.privateKey,
    encodeString(canonicalDeviceApprovalDecisionPayload(args)),
  ) as ArrayBuffer);

  const { data, error } = await supabase.functions.invoke('approve-device-enrollment', {
    body: {
      decision: args.decision,
      approver_device_id: args.approverDeviceId,
      target_device_id: args.target.deviceId,
      target_challenge_id: args.target.challengeId,
      approver_signature: approvalSignature,
      ...(args.selfApproval === true ? { self_approval: true } : {}),
    },
  });

  if (error) throw new Error(`DEVICE_APPROVAL_DECISION_FAILED:${error.message}`);
  const result = data as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    throw new Error(typeof result?.code === 'string' ? result.code : 'DEVICE_APPROVAL_DECISION_REJECTED');
  }

  const validApproveCodes = args.selfApproval === true
    ? new Set(['DEVICE_APPROVED_UNBOUND', 'DEVICE_APPROVED'])
    : new Set(['DEVICE_APPROVED']);
  const validCode = args.decision === 'approve'
    ? validApproveCodes.has(String(result.code ?? ''))
    : result.code === 'DEVICE_REVOKED';
  if (!validCode || result.device_id !== args.target.deviceId) {
    throw new Error('DEVICE_APPROVAL_DECISION_INVALID_RESPONSE');
  }

  return { deviceId: args.target.deviceId, decision: args.decision };
}

export async function submitDeviceApprovalDecision(args: {
  userId: string;
  approverDeviceId: string;
  target: PendingDeviceApprovalTarget;
  decision: DeviceApprovalDecision;
}): Promise<{ deviceId: string; decision: DeviceApprovalDecision }> {
  if (!args.userId) throw new Error('DEVICE_APPROVAL_USER_REQUIRED');
  if (!DEVICE_ID_RE.test(args.approverDeviceId)) throw new Error('DEVICE_APPROVER_INVALID_DEVICE_ID');
  validateTarget(args.target);
  if (args.approverDeviceId === args.target.deviceId) {
    throw new Error('DEVICE_SELF_APPROVAL_REQUIRES_EXPLICIT_FLOW');
  }
  return invokeApproval(args);
}

/**
 * Temporary V2 self-approval until email/QR approval exists. It proves the
 * authenticated user explicitly approved the request and that this exact
 * installation owns the pending Ed25519 private key. It does NOT bind the
 * account identity; that happens only after the PIN unlocks the account key.
 */
export async function submitSelfDeviceApprovalDecision(args: {
  userId: string;
  target: PendingDeviceApprovalTarget;
  decision: DeviceApprovalDecision;
}): Promise<{ deviceId: string; decision: DeviceApprovalDecision }> {
  if (!args.userId) throw new Error('DEVICE_APPROVAL_USER_REQUIRED');
  validateTarget(args.target);
  return invokeApproval({
    ...args,
    approverDeviceId: args.target.deviceId,
    selfApproval: true,
  });
}
