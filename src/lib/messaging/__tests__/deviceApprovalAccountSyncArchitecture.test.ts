import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync('src/lib/api/deviceApi.ts', 'utf8');
const decision = readFileSync('src/lib/crypto/deviceApprovalDecision.ts', 'utf8');
const approvalBridge = readFileSync('supabase/migrations/20260809190000_temporary_device_crypto_bridges.sql', 'utf8');
const atomicApproval = readFileSync('supabase/migrations/20260811143200_atomic_device_approval_authorization.sql', 'utf8');
const autoApproval = readFileSync(
  'supabase/migrations/20260909073359_538c185a-f83c-4a5c-9149-16b60c84e836.sql',
  'utf8',
);
const migration = readFileSync(
  'supabase/migrations/20260809170000_device_roles_and_trusted_approval.sql',
  'utf8',
).toLowerCase();

describe('canonical automatic device approval', () => {
  it('removes every manual approval path from the client', () => {
    expect(api).toContain('autoApprove');
    expect(api).not.toContain('submitTrustedDeviceApprovalDecision');
    expect(decision).toContain('submitAutomaticDeviceApproval');
    expect(decision).not.toContain('submitPrimaryBootstrapDecision');
  });

  it('keeps the approved transition server-side and fail-closed', () => {
    expect(decision).toContain("p_approver_device_id: args.target.deviceId");
    expect(decision).toContain("result.code !== 'DEVICE_APPROVED'");
    expect(autoApproval).toContain('DEVICE_EXTERNAL_APPROVER_FORBIDDEN');
    expect(autoApproval).toContain('NOT_AUTHENTICATED');
    expect(autoApproval).toContain('DEVICE_POSSESSION_SIGNATURE_INVALID');
    expect(autoApproval).toContain("d.user_id=v_uid and d.device_id=p_device_id");
    expect(autoApproval).toContain("'approval_mode','automatic'");
    expect(atomicApproval).toContain('approve_device_enrollment_decision_pre_account_authorization');
    expect(approvalBridge).toContain('APPROVER_DEVICE_NOT_READY');
  });

  it('enforces one live primary and a closed lifecycle in PostgreSQL', () => {
    expect(migration).toContain("device_role in ('primary', 'secondary')");
    expect(migration).toContain("lifecycle_status in ('pending', 'approved', 'syncing', 'ready', 'revoked')");
    expect(migration).toContain('user_devices_one_live_primary');
    expect(migration).toContain("to service_role");
  });

  it('only marks a device ready after binding and routing are ready', () => {
    expect(migration).toContain('complete_current_device_synchronization');
    expect(migration).toContain("v_device.binding_status <> 'bound'");
    expect(migration).toContain("v_device.routing_status <> 'ready'");
    expect(api).toContain("updated.lifecycleStatus !== 'ready'");
  });
});
