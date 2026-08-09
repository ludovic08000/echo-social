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

export async function submitTrustedDeviceApprovalDecision(args: {
  userId: string;
  approverDeviceId: string;
  target: PendingDeviceApprovalTarget;
  decision: DeviceApprovalDecision;
}): Promise<{ deviceId: string; decision: DeviceApprovalDecision }> {
  if (!args.userId) throw new Error('DEVICE_APPROVAL_USER_REQUIRED');
  validateTarget(args.target);
  if (!DEVICE_ID_RE.test(args.approverDeviceId)) throw new Error('DEVICE_APPROVER_INVALID_DEVICE_ID');
  if (args.approverDeviceId === args.target.deviceId) throw new Error('DEVICE_SELF_APPROVAL_FORBIDDEN');

  const identity = await loadDeviceIdentity(args.userId, args.approverDeviceId);
  if (!identity) throw new Error('DEVICE_PRIVATE_KEY_MISSING');

  const signature = bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    identity.privateKey,
    encodeString(canonicalDeviceApprovalDecisionPayload(args)),
  ) as ArrayBuffer);

  const { data, error } = await supabase.functions.invoke('approve-device-enrollment', {
    body: {
      action: 'decision',
      decision: args.decision,
      approver_device_id: args.approverDeviceId,
      device_id: args.target.deviceId,
      challenge_id: args.target.challengeId,
      signature,
    },
  });

  if (error) throw new Error(`DEVICE_APPROVAL_DECISION_FAILED:${error.message}`);
  const result = data as Record<string, unknown> | null;
  if (!result || result.ok !== true || result.device_id !== args.target.deviceId) {
    throw new Error(typeof result?.code === 'string' ? result.code : 'DEVICE_APPROVAL_DECISION_REJECTED');
  }

  const expectedCode = args.decision === 'approve' ? 'DEVICE_APPROVED' : 'DEVICE_REVOKED';
  if (result.code !== expectedCode) throw new Error('DEVICE_APPROVAL_DECISION_INVALID_RESPONSE');
  return { deviceId: args.target.deviceId, decision: args.decision };
}

export async function submitPrimaryBootstrapDecision(args: {
  userId: string;
  target: PendingDeviceApprovalTarget;
}): Promise<{ deviceId: string; decision: 'approve' }> {
  if (!args.userId) throw new Error('DEVICE_APPROVAL_USER_REQUIRED');
  validateTarget(args.target);
  const identity = await loadDeviceIdentity(args.userId, args.target.deviceId);
  if (!identity || identity.publicB64 !== args.target.deviceSigningKey) {
    throw new Error('DEVICE_BOOTSTRAP_LOCAL_IDENTITY_INVALID');
  }
  const payloadArgs = {
    userId: args.userId,
    approverDeviceId: args.target.deviceId,
    target: args.target,
    decision: 'approve' as const,
  };
  const signature = bufferToBase64(await hardCrypto.sign(
    'Ed25519', identity.privateKey, encodeString(canonicalDeviceApprovalDecisionPayload(payloadArgs)),
  ) as ArrayBuffer);
  const { data, error } = await supabase.functions.invoke('approve-device-enrollment', {
    body: {
      action: 'decision', decision: 'approve', bootstrap_primary: true,
      approver_device_id: args.target.deviceId, device_id: args.target.deviceId,
      challenge_id: args.target.challengeId, signature,
    },
  });
  if (error) throw new Error(`DEVICE_BOOTSTRAP_FAILED:${error.message}`);
  const result = data as Record<string, unknown> | null;
  if (!result || result.ok !== true || result.code !== 'DEVICE_APPROVED' || result.device_role !== 'primary') {
    throw new Error(typeof result?.code === 'string' ? result.code : 'DEVICE_BOOTSTRAP_REJECTED');
  }
  return { deviceId: args.target.deviceId, decision: 'approve' };
}
