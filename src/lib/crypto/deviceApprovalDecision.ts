import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { loadDeviceIdentity, signDeviceAuthorization } from '@/lib/crypto/deviceIdentity';
import { exportPublicKeyBundle, loadIdentityKeys } from '@/lib/crypto/keyManager';
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

async function createAccountDeviceAuthorization(args: {
  userId: string;
  approverDeviceId: string;
  target: PendingDeviceApprovalTarget;
}): Promise<string> {
  // A trusted-device approval must use the already-existing ACCOUNT signing
  // private key. Never create a replacement identity here: if continuity is
  // missing, approval fails closed and recovery must restore the account key.
  let accountKeys = await loadIdentityKeys(args.userId);
  if (!accountKeys) {
    const { isWindowsWeb, recoverCurrentWindowsHelloDevice } = await import(
      '@/lib/crypto/windowsHelloDeviceRecovery'
    );
    if (isWindowsWeb()) {
      const recoveredDeviceId = await recoverCurrentWindowsHelloDevice(args.userId);
      if (recoveredDeviceId !== args.approverDeviceId) {
        throw new Error('DEVICE_APPROVAL_WINDOWS_HELLO_DEVICE_MISMATCH');
      }
      accountKeys = await loadIdentityKeys(args.userId);
    }
  }
  if (!accountKeys) throw new Error('DEVICE_APPROVAL_ACCOUNT_PRIVATE_KEY_MISSING');

  const account = await exportPublicKeyBundle(accountKeys);
  return signDeviceAuthorization({
    userId: args.userId,
    deviceId: args.target.deviceId,
    accountFingerprint: account.fingerprint,
    devicePublicKey: args.target.devicePublicKey,
    deviceSigningKey: args.target.deviceSigningKey,
    accountSigningPrivateKey: accountKeys.signingPrivateKey,
  });
}

async function callApprovalRpc(args: {
  decision: DeviceApprovalDecision;
  bootstrapPrimary: boolean;
  approverDeviceId: string;
  target: PendingDeviceApprovalTarget;
  signature: string;
  deviceAuthorizationSignature: string | null;
}): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('approve_device_enrollment_decision' as never, {
    p_decision: args.decision,
    p_bootstrap_primary: args.bootstrapPrimary,
    p_approver_device_id: args.approverDeviceId,
    p_device_id: args.target.deviceId,
    p_challenge_id: args.target.challengeId,
    p_signature: args.signature,
    p_device_authorization_signature: args.deviceAuthorizationSignature,
  } as never);

  if (error) throw new Error(`DEVICE_APPROVAL_RPC_FAILED:${error.message}`);
  const result = data as Record<string, unknown> | null;
  if (!result) throw new Error('DEVICE_APPROVAL_RPC_EMPTY_RESPONSE');
  return result;
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

  // The approving DEVICE signs the user's explicit decision, binding the
  // challenge and target public keys to the trusted device that made it.
  const signature = bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    identity.privateKey,
    encodeString(canonicalDeviceApprovalDecisionPayload(args)),
  ) as ArrayBuffer);

  // On approval only, the ACCOUNT identity additionally authorizes the target
  // device. This is generated at the click, before the server may transition
  // the target to approved. Rejecting a device never grants account trust.
  const deviceAuthorizationSignature = args.decision === 'approve'
    ? await createAccountDeviceAuthorization({
      userId: args.userId,
      approverDeviceId: args.approverDeviceId,
      target: args.target,
    })
    : null;

  const result = await callApprovalRpc({
    decision: args.decision,
    bootstrapPrimary: false,
    approverDeviceId: args.approverDeviceId,
    target: args.target,
    signature,
    deviceAuthorizationSignature,
  });

  if (result.ok !== true || result.device_id !== args.target.deviceId) {
    throw new Error(typeof result.code === 'string' ? result.code : 'DEVICE_APPROVAL_DECISION_REJECTED');
  }

  const expectedCode = args.decision === 'approve' ? 'DEVICE_APPROVED' : 'DEVICE_REVOKED';
  if (result.code !== expectedCode) throw new Error('DEVICE_APPROVAL_DECISION_INVALID_RESPONSE');
  if (args.decision === 'approve' && (result.binding_status !== 'bound' || result.account_authorized !== true)) {
    throw new Error('DEVICE_APPROVAL_ACCOUNT_AUTHORIZATION_MISSING');
  }
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
    'Ed25519',
    identity.privateKey,
    encodeString(canonicalDeviceApprovalDecisionPayload(payloadArgs)),
  ) as ArrayBuffer);

  const result = await callApprovalRpc({
    decision: 'approve',
    bootstrapPrimary: true,
    approverDeviceId: args.target.deviceId,
    target: args.target,
    signature,
    deviceAuthorizationSignature: null,
  });

  if (result.ok !== true || result.code !== 'DEVICE_APPROVED' || result.device_role !== 'primary') {
    throw new Error(typeof result.code === 'string' ? result.code : 'DEVICE_BOOTSTRAP_REJECTED');
  }
  return { deviceId: args.target.deviceId, decision: 'approve' };
}
