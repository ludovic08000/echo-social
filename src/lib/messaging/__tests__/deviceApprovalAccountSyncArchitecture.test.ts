import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync('src/lib/api/deviceApi.ts', 'utf8');
const decision = readFileSync('src/lib/crypto/deviceApprovalDecision.ts', 'utf8');
const approvalBridge = readFileSync('supabase/migrations/20260809190000_temporary_device_crypto_bridges.sql', 'utf8');
const atomicApproval = readFileSync('supabase/migrations/20260811143200_atomic_device_approval_authorization.sql', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260809170000_device_roles_and_trusted_approval.sql',
  'utf8',
).toLowerCase();

describe('canonical primary and secondary device approval', () => {
  it('keeps bootstrap separate from secondary approval', () => {
    expect(api).toContain('bootstrapPrimary');
    expect(decision).toContain('submitPrimaryBootstrapDecision');
    expect(decision).toContain('submitTrustedDeviceApprovalDecision');
    expect(decision).toContain('DEVICE_SELF_APPROVAL_FORBIDDEN');
  });

  it('binds a secondary decision to the approver, target and account authorization', () => {
    expect(decision).toContain('approverDeviceId: args.approverDeviceId');
    expect(decision).toContain('p_approver_device_id: args.approverDeviceId');
    expect(decision).toContain('p_device_authorization_signature: args.deviceAuthorizationSignature');
    expect(approvalBridge).toContain('APPROVER_DEVICE_NOT_READY');
    expect(approvalBridge).toContain('DEVICE_SELF_APPROVAL_FORBIDDEN');
    expect(atomicApproval).toContain('DEVICE_AUTHORIZATION_SIGNATURE_REQUIRED');
    expect(atomicApproval).toContain('p_device_authorization_signature');
    expect(atomicApproval).toContain('approve_device_enrollment_decision_pre_account_authorization');
  });

  it('enforces one live primary and a closed lifecycle in PostgreSQL', () => {
    expect(migration).toContain("device_role in ('primary', 'secondary')");
    expect(migration).toContain("lifecycle_status in ('pending', 'approved', 'syncing', 'ready', 'revoked')");
    expect(migration).toContain('user_devices_one_live_primary');
    expect(migration).toContain("v_approver.lifecycle_status <> 'ready'");
    expect(migration).toContain("to service_role");
  });

  it('only marks a device ready after binding and routing are ready', () => {
    expect(migration).toContain('complete_current_device_synchronization');
    expect(migration).toContain("v_device.binding_status <> 'bound'");
    expect(migration).toContain("v_device.routing_status <> 'ready'");
    expect(api).toContain("updated.lifecycleStatus !== 'ready'");
  });
});
