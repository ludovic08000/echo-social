import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const enrollmentClient = readFileSync('src/lib/crypto/serverDeviceEnrollment.ts', 'utf8');
const deviceRuntime = readFileSync('src/lib/messaging/aegisDeviceRuntime.ts', 'utf8');
const approvalBridge = readFileSync(
  'supabase/migrations/20260809190000_temporary_device_crypto_bridges.sql',
  'utf8',
);
const atomicApproval = readFileSync(
  'supabase/migrations/20260811143200_atomic_device_approval_authorization.sql',
  'utf8',
);
const supabaseConfig = readFileSync('supabase/config.toml', 'utf8');

describe('server-verified device enrollment architecture', () => {
  it('never approves a device directly from the enrollment client', () => {
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

  it('verifies possession in the predecessor RPC and account authorization atomically', () => {
    expect(approvalBridge).toContain('forsure-aegis-device-approval-decision');
    expect(approvalBridge).toContain('forsure-aegis-device-possession');
    expect(approvalBridge).toContain('verify_ed25519_b64');
    expect(approvalBridge).toContain('DEVICE_POSSESSION_SIGNATURE_INVALID');
    expect(atomicApproval).toContain('ACCOUNT_BINDING_SIGNATURE_INVALID');
    expect(atomicApproval).toContain('DEVICE_AUTHORIZATION_SIGNATURE_INVALID');
    expect(atomicApproval).toContain('DEVICE_AUTHORIZATION_SIGNATURE_REQUIRED');
    expect(atomicApproval).toContain('p_device_authorization_signature');
  });

  it('uses only the SQL RPC and removes the obsolete approval Edge Function', () => {
    expect(existsSync('supabase/functions/approve-device-enrollment/index.ts')).toBe(false);
    expect(supabaseConfig).not.toContain('[functions.approve-device-enrollment]');
  });
});
