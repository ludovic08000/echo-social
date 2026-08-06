import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registration = readFileSync('src/hooks/useDeviceRegistration.ts', 'utf8');
const enrollment = readFileSync('src/lib/crypto/serverDeviceEnrollment.ts', 'utf8');
const approvalClient = readFileSync('src/lib/crypto/deviceApprovalDecision.ts', 'utf8');
const approvalFunction = readFileSync('supabase/functions/approve-device-enrollment/index.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260806180000_require_trusted_device_decision.sql',
  'utf8',
);

describe('trusted-device approval architecture', () => {
  it('leaves a completed enrollment pending and does not publish prekeys yet', () => {
    const completed = enrollment.indexOf('return parseCompletedDeviceEnrollment');
    const legacyBlock = enrollment.indexOf('DEVICE_APPROVAL_REQUIRES_TRUSTED_DEVICE');
    const pendingReturn = registration.indexOf("trace('DEVICE_ENROLLMENT_PENDING')");
    const prekeyPublication = registration.indexOf('refreshDeviceSignedPrekeyIfNeeded');

    expect(completed).toBeGreaterThan(-1);
    expect(legacyBlock).toBeGreaterThan(-1);
    expect(enrollment).not.toContain("functions.invoke('approve-device-enrollment'");
    expect(registration).not.toContain('approveServerAssignedDevice(');
    expect(pendingReturn).toBeGreaterThan(-1);
    expect(prekeyPublication).toBeGreaterThan(pendingReturn);
  });

  it('requires another approved device to sign approve or reject', () => {
    expect(approvalClient).toContain('DEVICE_SELF_APPROVAL_FORBIDDEN');
    expect(approvalClient).toContain("protocol: 'forsure-aegis-device-approval-decision'");
    expect(approvalFunction).toContain('APPROVER_DEVICE_NOT_TRUSTED');
    expect(approvalFunction).toContain('APPROVER_SIGNATURE_INVALID');
    expect(approvalFunction).toContain('DEVICE_SELF_APPROVAL_FORBIDDEN');
    expect(approvalFunction).toContain('finalize_verified_user_device_approval_from_device');
    expect(approvalFunction).toContain('reject_verified_user_device_enrollment');
  });

  it('turns refusal into an immediate revocation', () => {
    expect(migration).toContain("approval_status = 'rejected'");
    expect(migration).toContain('revoked_at = v_now');
    expect(migration).toContain("revoke_reason = 'USER_REJECTED_DEVICE_ENROLLMENT'");
    expect(migration).toContain("'code', 'DEVICE_REVOKED'");
  });

  it('restores the canonical account identity before creating a new DeviceID', () => {
    const restoreCheck = registration.indexOf('await ensureCanonicalAccountIdentity(user.id)');
    const challengeStart = registration.indexOf('await beginServerAssignedDeviceEnrollment');
    expect(restoreCheck).toBeGreaterThan(-1);
    expect(challengeStart).toBeGreaterThan(restoreCheck);
    expect(registration).toContain('deleteRawIdentityKeys(userId)');
    expect(registration).toContain('local.fingerprint !== expectedFingerprint');
  });
});
