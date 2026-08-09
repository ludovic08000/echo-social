import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const currentDevice = readFileSync('src/lib/messaging/currentDevice.ts', 'utf8');
const enrollment = readFileSync('src/lib/crypto/serverDeviceEnrollment.ts', 'utf8');
const enrollmentGate = readFileSync('src/lib/crypto/deviceEnrollmentGate.ts', 'utf8');
const deviceApi = readFileSync('src/lib/api/deviceApi.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260809143000_aegis_canonical_device_lifecycle.sql',
  'utf8',
).toLowerCase();

describe('stable DeviceID architecture', () => {
  it('never allocates a replacement from ordinary read or hydration paths', () => {
    const getBody = currentDevice.match(/export function getCurrentDeviceId[\s\S]*?\n}/)?.[0] ?? '';
    const hydrateBody = currentDevice.match(/export async function hydrateDeviceId[\s\S]*?\n}/)?.[0] ?? '';
    expect(getBody).not.toContain('generateId()');
    expect(hydrateBody).not.toContain('generateId()');
    expect(getBody).toContain('DEVICE_ID_UNINITIALIZED');
    expect(hydrateBody).toContain('DEVICE_ID_REAPPROVAL_REQUIRED');
  });

  it('creates a local DeviceID only behind explicit enrollment', () => {
    const explicitBody = currentDevice.match(/export async function beginExplicitDeviceEnrollment[\s\S]*?\n}/)?.[0] ?? '';
    expect(explicitBody).toContain('authorizeExplicitDeviceEnrollment');
    expect(explicitBody).toContain('generateId()');
    expect(explicitBody).toContain('cancelLocalEnrollmentTransition');
  });

  it('bounds the one-shot server DeviceID transition', () => {
    expect(currentDevice).toContain('EXPLICIT_ENROLLMENT_TRANSITION_TTL_MS');
    expect(currentDevice).toContain('explicitEnrollmentExpiresAt > Date.now()');
    expect(currentDevice).toContain('SERVER_DEVICE_ID_RE.test(id)');
    expect(currentDevice).toContain('cancelExplicitDeviceEnrollmentAuthorization');
  });

  it('blocks server enrollment unless explicit authorization is consumed', () => {
    expect(enrollment).toContain('consumeExplicitDeviceEnrollmentAuthorization();');
    expect(enrollment.indexOf('consumeExplicitDeviceEnrollmentAuthorization();'))
      .toBeLessThan(enrollment.indexOf("supabase.rpc('begin_user_device_enrollment'"));
    expect(enrollmentGate).toContain('DEVICE_ENROLLMENT_REQUIRES_EXPLICIT_USER_ACTION');
  });

  it('does not use browser or hardware fingerprints for enrollment or recovery', () => {
    expect(enrollment).not.toContain('deviceFingerprint');
    expect(enrollment).not.toContain('p_device_fingerprint');
    expect(currentDevice).not.toContain('hardwareConcurrency');
    expect(currentDevice).not.toContain('screen.width');
    expect(currentDevice).not.toContain('resolve_device_id_by_fingerprint');
    expect(migration).toContain('drop column if exists device_fingerprint');
    expect(migration).toContain("'resolve_device_id_by_fingerprint'");
  });

  it('uses deviceApi as the canonical lifecycle orchestrator', () => {
    expect(deviceApi).toContain('beginServerAssignedDeviceEnrollment');
    expect(deviceApi).toContain('completeServerAssignedDeviceEnrollment');
    expect(deviceApi).toContain('submitTrustedDeviceApprovalDecision');
    expect(deviceApi).toContain('submitPrimaryBootstrapDecision');
    expect(deviceApi).toContain('bindApprovedDeviceToAccount');
    expect(deviceApi).toContain('prepareKeys');
    expect(deviceApi).not.toContain('register_user_device_safe');
    expect(deviceApi).not.toContain('approve_user_device');
  });
});
