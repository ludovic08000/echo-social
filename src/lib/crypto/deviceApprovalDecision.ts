import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import {
  exportPublicKeyBundle,
  loadIdentityKeys,
} from '@/lib/crypto/keyManager';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManagerSafe';
import {
  loadDeviceIdentity,
  signDeviceAuthorization,
} from '@/lib/crypto/deviceIdentity';
import { bufferToBase64, encodeString } from '@/lib/crypto/utils';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeviceApprovalDecision = 'approve' | 'reject';
export type AccountIdentityApprovalMode = 'account_recovery' | 'first_device_bootstrap';

export interface PendingDeviceApprovalTarget {
  deviceId: string;
  challengeId: string;
  devicePublicKey: string;
  deviceSigningKey: string;
  deviceAuthorizationSignature?: string | null;
}

function validateTarget(target: PendingDeviceApprovalTarget): void {
  if (!DEVICE_ID_RE.test(target.deviceId)) {
    throw new Error('DEVICE_APPROVAL_INVALID_DEVICE_ID');
  }
  if (!UUID_RE.test(target.challengeId)) {
    throw new Error('DEVICE_APPROVAL_INVALID_CHALLENGE_ID');
  }
  if (target.devicePublicKey.length < 40 || target.deviceSigningKey.length < 40) {
    throw new Error('DEVICE_APPROVAL_TARGET_KEYS_INVALID');
  }
}

export function canonicalDeviceApprovalDecisionPayload(args: {
  userId: string;
  approverDeviceId: string;
  target: PendingDeviceApprovalTarget;
  decision: DeviceApprovalDecision;
}): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-device-approval-decision',
    version: 2,
    userId: args.userId,
    approverDeviceId: args.approverDeviceId,
    targetDeviceId: args.target.deviceId,
    targetChallengeId: args.target.challengeId,
    targetDevicePublicKey: args.target.devicePublicKey,
    targetDeviceSigningKey: args.target.deviceSigningKey,
    targetDeviceAuthorizationSignature: args.target.deviceAuthorizationSignature ?? null,
    decision: args.decision,
  });
}

/**
 * Approval by an already approved installation. The installation signs the
 * user's explicit decision, while the stable account identity authorizes the
 * target device public keys.
 */
export async function submitDeviceApprovalDecision(args: {
  userId: string;
  approverDeviceId: string;
  target: PendingDeviceApprovalTarget;
  decision: DeviceApprovalDecision;
}): Promise<{ deviceId: string; decision: DeviceApprovalDecision }> {
  if (!args.userId) throw new Error('DEVICE_APPROVAL_USER_REQUIRED');
  if (!DEVICE_ID_RE.test(args.approverDeviceId)) {
    throw new Error('DEVICE_APPROVER_INVALID_DEVICE_ID');
  }
  validateTarget(args.target);
  if (args.approverDeviceId === args.target.deviceId) {
    throw new Error('DEVICE_SELF_APPROVAL_FORBIDDEN');
  }

  const approverIdentity = await loadDeviceIdentity(args.userId, args.approverDeviceId);
  if (!approverIdentity) throw new Error('DEVICE_APPROVER_PRIVATE_KEY_MISSING');

  let targetDeviceAuthorizationSignature: string | null = null;
  if (args.decision === 'approve') {
    const accountIdentity = await loadIdentityKeys(args.userId);
    if (!accountIdentity) throw new Error('DEVICE_APPROVER_ACCOUNT_IDENTITY_MISSING');
    targetDeviceAuthorizationSignature = await signDeviceAuthorization({
      userId: args.userId,
      deviceId: args.target.deviceId,
      accountFingerprint: accountIdentity.fingerprint,
      devicePublicKey: args.target.devicePublicKey,
      deviceSigningKey: args.target.deviceSigningKey,
      accountSigningPrivateKey: accountIdentity.signingPrivateKey,
    });
  }

  const signedTarget: PendingDeviceApprovalTarget = {
    ...args.target,
    deviceAuthorizationSignature: targetDeviceAuthorizationSignature,
  };

  const approvalSignature = bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    approverIdentity.privateKey,
    encodeString(canonicalDeviceApprovalDecisionPayload({
      ...args,
      target: signedTarget,
    })),
  ) as ArrayBuffer);

  const { data, error } = await supabase.functions.invoke('approve-device-enrollment', {
    body: {
      decision: args.decision,
      approver_device_id: args.approverDeviceId,
      target_device_id: args.target.deviceId,
      target_challenge_id: args.target.challengeId,
      target_device_authorization_signature: targetDeviceAuthorizationSignature,
      approver_signature: approvalSignature,
    },
  });

  if (error) throw new Error(`DEVICE_APPROVAL_DECISION_FAILED:${error.message}`);
  const result = data as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    throw new Error(typeof result?.code === 'string' ? result.code : 'DEVICE_APPROVAL_DECISION_REJECTED');
  }

  const expectedCode = args.decision === 'approve' ? 'DEVICE_APPROVED' : 'DEVICE_REVOKED';
  if (result.code !== expectedCode || result.device_id !== args.target.deviceId) {
    throw new Error('DEVICE_APPROVAL_DECISION_INVALID_RESPONSE');
  }

  return { deviceId: args.target.deviceId, decision: args.decision };
}

export function canonicalAccountIdentityDeviceApprovalPayload(args: {
  mode: AccountIdentityApprovalMode;
  userId: string;
  target: PendingDeviceApprovalTarget;
  accountFingerprint: string;
  deviceAuthorizationSignature: string;
}): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-account-device-recovery-approval',
    version: 1,
    mode: args.mode,
    userId: args.userId,
    targetDeviceId: args.target.deviceId,
    targetChallengeId: args.target.challengeId,
    targetDevicePublicKey: args.target.devicePublicKey,
    targetDeviceSigningKey: args.target.deviceSigningKey,
    targetDeviceAuthorizationSignature: args.deviceAuthorizationSignature,
    accountFingerprint: args.accountFingerprint,
    decision: 'approve',
  });
}

/**
 * Approve a pending installation by proving possession of the stable account
 * identity. This is the recovery path when no other approved installation is
 * available, and the bootstrap path for a genuinely new account.
 *
 * A password or recovery key never approves a device by itself. It only
 * restores the account signing private key locally; that key signs the exact
 * pending challenge and device public keys below.
 */
export async function submitAccountIdentityDeviceApproval(args: {
  userId: string;
  target: PendingDeviceApprovalTarget;
}): Promise<{ deviceId: string; mode: AccountIdentityApprovalMode }> {
  if (!args.userId) throw new Error('DEVICE_APPROVAL_USER_REQUIRED');
  validateTarget(args.target);

  const { data: serverAccount, error: accountLookupError } = await supabase
    .from('user_public_keys')
    .select('fingerprint')
    .eq('user_id', args.userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (accountLookupError) {
    throw new Error(`ACCOUNT_IDENTITY_LOOKUP_FAILED:${accountLookupError.message}`);
  }

  let expectedFingerprint = String(serverAccount?.fingerprint ?? '').trim();
  if (expectedFingerprint.length < 32) {
    const { data: recoveryVault, error: recoveryVaultError } = await supabase
      .from('aegis_recovery_vaults' as never)
      .select('identity_fingerprint')
      .eq('user_id', args.userId)
      .maybeSingle();

    if (recoveryVaultError) {
      throw new Error(`ACCOUNT_RECOVERY_VAULT_LOOKUP_FAILED:${recoveryVaultError.message}`);
    }
    expectedFingerprint = String(
      (recoveryVault as { identity_fingerprint?: unknown } | null)?.identity_fingerprint ?? '',
    ).trim();
  }

  const mode: AccountIdentityApprovalMode = expectedFingerprint.length >= 32
    ? 'account_recovery'
    : 'first_device_bootstrap';

  let accountIdentity = await loadIdentityKeys(args.userId);
  if (!accountIdentity && mode === 'first_device_bootstrap') {
    accountIdentity = await getOrCreateIdentityKeys(args.userId);
  }
  if (!accountIdentity) {
    throw new Error('ACCOUNT_RECOVERY_KEYS_REQUIRED');
  }

  if (
    mode === 'account_recovery'
    && accountIdentity.fingerprint !== expectedFingerprint
  ) {
    throw new Error('ACCOUNT_RECOVERY_IDENTITY_MISMATCH');
  }

  const account = await exportPublicKeyBundle(accountIdentity);
  if (account.fingerprint !== accountIdentity.fingerprint) {
    throw new Error('ACCOUNT_RECOVERY_PUBLIC_BUNDLE_MISMATCH');
  }

  const deviceAuthorizationSignature = await signDeviceAuthorization({
    userId: args.userId,
    deviceId: args.target.deviceId,
    accountFingerprint: account.fingerprint,
    devicePublicKey: args.target.devicePublicKey,
    deviceSigningKey: args.target.deviceSigningKey,
    accountSigningPrivateKey: accountIdentity.signingPrivateKey,
  });

  const recoverySignature = bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    accountIdentity.signingPrivateKey,
    encodeString(canonicalAccountIdentityDeviceApprovalPayload({
      mode,
      userId: args.userId,
      target: args.target,
      accountFingerprint: account.fingerprint,
      deviceAuthorizationSignature,
    })),
  ) as ArrayBuffer);

  const { data, error } = await supabase.functions.invoke('recover-device-enrollment', {
    body: {
      mode,
      target_device_id: args.target.deviceId,
      target_challenge_id: args.target.challengeId,
      target_device_authorization_signature: deviceAuthorizationSignature,
      account_recovery_signature: recoverySignature,
      account_identity_key: account.identityKey,
      account_signing_key: account.signingKey,
      account_fingerprint: account.fingerprint,
      account_binding_signature: account.bindingSignature,
      account_binding_version: account.bindingVersion,
    },
  });

  if (error) throw new Error(`ACCOUNT_DEVICE_APPROVAL_FAILED:${error.message}`);
  const result = data as Record<string, unknown> | null;
  if (
    !result
    || result.ok !== true
    || result.code !== 'DEVICE_APPROVED'
    || result.device_id !== args.target.deviceId
    || result.mode !== mode
  ) {
    throw new Error(
      typeof result?.code === 'string'
        ? result.code
        : 'ACCOUNT_DEVICE_APPROVAL_INVALID_RESPONSE',
    );
  }

  return { deviceId: args.target.deviceId, mode };
}
