import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const enrollmentClient = readFileSync('src/lib/crypto/serverDeviceEnrollment.ts', 'utf8');
const deviceRuntime = readFileSync('src/lib/messaging/aegisDeviceRuntime.ts', 'utf8');
const approvalFunction = readFileSync(
  'supabase/functions/approve-device-enrollment/index.ts',
  'utf8',
);
const supabaseConfig = readFileSync('supabase/config.toml', 'utf8');

describe('server-verified device enrollment architecture', () => {
  it('never approves a device directly from the enrollment client', () => {
    // Invariant : l'approbation passe par deviceApprovalDecision + Edge Function signée.
    expect(enrollmentClient).not.toContain("supabase.rpc(\n    'approve_user_device'");
  });

  it('keeps enrollment metadata free of any hardware signal', () => {
    expect(enrollmentClient).not.toContain('deviceFingerprint');
    expect(enrollmentClient).not.toContain('p_device_fingerprint');
  });

  it('requires authorization, routing and a valid SPK before send', () => {
    expect(deviceRuntime).toContain('ensureApprovedDeviceTrust');
    expect(deviceRuntime).toContain('await ensureApprovedDeviceTrust(userId, deviceId)');
    expect(deviceRuntime).not.toContain('readyByUser.set(userId, ready);\n    return ready;\n  })();');
  });

  it('verifies canonical Ed25519 proofs and uses the atomic account-authorized approval RPC', () => {
    expect(approvalFunction).toContain('forsure-aegis-account-identity');
    expect(approvalFunction).toContain('forsure-aegis-device-authorization');
    expect(approvalFunction).toContain('crypto.subtle.verify');
    expect(approvalFunction).toContain('ACCOUNT_BINDING_SIGNATURE_INVALID');
    expect(approvalFunction).toContain('DEVICE_AUTHORIZATION_SIGNATURE_INVALID');
    expect(approvalFunction).toContain('DEVICE_AUTHORIZATION_SIGNATURE_REQUIRED');
    expect(approvalFunction).toContain('rpc("approve_device_enrollment_decision"');
    expect(approvalFunction).toContain('p_device_authorization_signature');
    expect(approvalFunction).not.toContain('rpc("finalize_device_approval_decision"');
    expect(approvalFunction).not.toContain('rpc("approve_device_enrollment_request"');
    expect(approvalFunction).not.toContain('rpc("approve_user_device_for_current_user"');
  });

  it('enables JWT verification for the approval function', () => {
    expect(supabaseConfig).toContain('[functions.approve-device-enrollment]');
    expect(supabaseConfig).toMatch(
      /\[functions\.approve-device-enrollment\]\s+verify_jwt\s*=\s*true/,
    );
  });
});
