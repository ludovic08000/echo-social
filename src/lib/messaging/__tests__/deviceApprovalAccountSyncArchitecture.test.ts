import { existsSync, readFileSync } from 'node:fs';
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

describe('single canonical device lifecycle authority', () => {
  const controller = readFileSync('src/lib/device-manager/deviceLifecycleController.ts', 'utf8');
  const gate = readFileSync('src/components/messaging/DeviceApprovalGate.tsx', 'utf8');
  const lifecycle = readFileSync('src/hooks/useDeviceLifecycle.ts', 'utf8');
  const messagingGate = readFileSync('src/components/MessagingPinGate.tsx', 'utf8');

  it('auto-enrolls the current device outside Windows Hello recovery', () => {
    expect(controller).toContain("if (this.deps.isWindowsWeb() && !this.manualEnrollmentRequested) return null;");
    expect(controller).toContain("return 'enrolling';");
  });

  it('keeps a single authority: no view drives a transition itself', () => {
    expect(lifecycle).toContain('getDeviceLifecycleController');
    expect(lifecycle).not.toContain('deviceApi.bind(userId)');
    expect(lifecycle).not.toContain('deviceApi.prepareKeys(userId)');
    expect(gate).not.toContain('usePrePinDeviceEnrollment');
    expect(existsSync('src/hooks/usePrePinDeviceEnrollment.ts')).toBe(false);
    expect(existsSync('src/components/messaging/DeviceAccountBindingGate.tsx')).toBe(false);
  });

  it('removes the manual waiting screens but keeps Windows Hello recovery', () => {
    expect(gate).toContain('Enregistrement de cet appareil…');
    expect(gate).toContain('Activation de cet appareil…');
    expect(gate).toContain('recoverCurrentWindowsHelloDevice(user.id)');
    expect(gate).not.toContain('Approuver');
  });

  it('keeps verification and key finalization fail-closed without the duplicate binding gate', () => {
    expect(gate).toContain('Vérification de cet appareil…');
    expect(gate).toContain('Finalisation de cet appareil…');
    expect(gate).toContain('lifecycle.transitionError');
    expect(messagingGate).not.toContain('DeviceAccountBindingGate');
  });

  it('never leaves a gate spinning on a failed server read', () => {
    expect(controller).toContain('DEVICE_STATE_LOOKUP_FAILED');
    expect(controller).toContain('withStepTimeout');
    expect(controller).toContain('this.blockedUntilRetry = true;');
    expect(gate).toContain('Réessayer');
  });

  it('deduplicates every binding and key setup caller in the central API', () => {
    expect(api).toContain('const bindInFlight = new Map<string, Promise<DeviceApiRecord>>();');
    expect(api).toContain('const keySetupInFlight = new Map<string, Promise<DeviceApiRecord>>();');
    expect(api).toContain('runDeviceTransitionOnce');
    expect(lifecycle).not.toContain('bindingTransitions');
    expect(lifecycle).not.toContain('keySetupTransitions');
  });

  it('publishes the signed prekey the server route readiness check requires', () => {
    expect(api).toContain('refreshDeviceSignedPrekeyIfNeeded(userId, record.deviceId, identity.privateKey)');
    expect(api.indexOf('refreshDeviceSignedPrekeyIfNeeded'))
      .toBeLessThan(api.indexOf('mark_current_device_route_ready'));
    expect(api).toContain('void refillDeviceOneTimePrekeysIfNeeded(userId, record.deviceId)');
  });

  it('never derives trust from a device fingerprint', () => {
    expect(controller).not.toContain('fingerprint');
    expect(lifecycle).not.toContain('fingerprint');
  });

  it('enforces the exact canonical order', () => {
    const machine = readFileSync('src/lib/device-manager/deviceLifecycleMachine.ts', 'utf8');
    const order = [
      'AUTHENTICATED', 'DEVICE_CREDENTIAL_CHECK', 'LINK_REQUIRED', 'PENDING_APPROVAL',
      'APPROVED_LOCKED', 'PIN_UNLOCK', 'ACCOUNT_BINDING', 'DEVICE_KEY_SETUP',
      'ACCOUNT_KEY_SYNC', 'MESSAGING_READY',
    ];
    let cursor = -1;
    for (const state of order) {
      const next = machine.indexOf(`'${state}'`);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });
});
