import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registration = readFileSync('src/hooks/useDeviceRegistration.ts', 'utf8');
const enrollment = readFileSync('src/lib/crypto/serverDeviceEnrollment.ts', 'utf8');
const approvalClient = readFileSync('src/lib/crypto/deviceApprovalDecision.ts', 'utf8');
const approvalFunction = readFileSync('supabase/functions/approve-device-enrollment/index.ts', 'utf8');
const trustedDecisionMigration = readFileSync(
  'supabase/migrations/20260806180000_require_trusted_device_decision.sql',
  'utf8',
);
const candidateMigration = readFileSync(
  'supabase/migrations/20260806210000_stage_device_before_account_restore.sql',
  'utf8',
);
const recoveryDialog = readFileSync(
  'src/components/messages/E2EERestorePromptDialog.tsx',
  'utf8',
);

describe('trusted-device approval architecture', () => {
  it('stages device-owned public material and does not publish prekeys yet', () => {
    const completed = enrollment.indexOf('complete_user_device_enrollment_candidate');
    const legacyBlock = enrollment.indexOf('DEVICE_APPROVAL_REQUIRES_TRUSTED_DEVICE');
    const pendingReturn = registration.indexOf("trace('DEVICE_ENROLLMENT_PENDING')");
    const prekeyPublication = registration.indexOf('await refreshDeviceSignedPrekeyIfNeeded');

    expect(completed).toBeGreaterThan(-1);
    expect(legacyBlock).toBeGreaterThan(-1);
    expect(enrollment).not.toContain("functions.invoke('approve-device-enrollment'");
    expect(registration).not.toContain('approveServerAssignedDevice(');
    expect(pendingReturn).toBeGreaterThan(-1);
    expect(prekeyPublication).toBeGreaterThan(pendingReturn);
    expect(candidateMigration).toContain('device_authorization_signature = null');
  });

  it('requires another approved device to sign account authorization and approve or reject', () => {
    expect(approvalClient).toContain('DEVICE_SELF_APPROVAL_FORBIDDEN');
    expect(approvalClient).toContain("protocol: 'forsure-aegis-device-approval-decision'");
    expect(approvalClient).toContain('signDeviceAuthorization');
    expect(approvalClient).toContain('target_device_authorization_signature');
    expect(approvalFunction).toContain('APPROVER_DEVICE_NOT_TRUSTED');
    expect(approvalFunction).toContain('APPROVER_SIGNATURE_INVALID');
    expect(approvalFunction).toContain('DEVICE_AUTHORIZATION_SIGNATURE_INVALID');
    expect(approvalFunction).toContain('DEVICE_SELF_APPROVAL_FORBIDDEN');
    expect(approvalFunction).toContain('finalize_verified_user_device_approval_from_device');
    expect(approvalFunction).toContain('reject_verified_user_device_enrollment');
  });

  it('turns refusal into an immediate revocation', () => {
    expect(trustedDecisionMigration).toContain("approval_status = 'rejected'");
    expect(trustedDecisionMigration).toContain('revoked_at = v_now');
    expect(trustedDecisionMigration).toContain("revoke_reason = 'USER_REJECTED_DEVICE_ENROLLMENT'");
    expect(trustedDecisionMigration).toContain("'code', 'DEVICE_REVOKED'");
  });

  it('creates pending UI state before any canonical account restoration', () => {
    const challengeStart = registration.indexOf('await beginServerAssignedDeviceEnrollment');
    const candidateCompletion = registration.indexOf('await completeServerAssignedDeviceEnrollmentCandidate');
    const pendingEvent = registration.indexOf('dispatchPendingDevice(deviceId)');
    const restoreCheck = registration.indexOf('await ensureCanonicalAccountIdentity(user.id)');

    expect(challengeStart).toBeGreaterThan(-1);
    expect(candidateCompletion).toBeGreaterThan(challengeStart);
    expect(pendingEvent).toBeGreaterThan(candidateCompletion);
    expect(restoreCheck).toBeGreaterThan(pendingEvent);
    expect(candidateCompletion).toBeLessThan(restoreCheck);
  });

  it('prevents the legacy recovery UI from opening on a pending device', () => {
    expect(recoveryDialog).toContain('currentDeviceIsApproved');
    expect(recoveryDialog).toContain("data.approval_status === 'approved'");
    expect(recoveryDialog).toContain('if (!(await currentDeviceIsApproved(user.id))) return');
  });
});
