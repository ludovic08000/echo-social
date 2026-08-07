import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const currentDevice = readFileSync('src/lib/messaging/currentDevice.ts', 'utf8');
const enrollment = readFileSync('src/lib/crypto/serverDeviceEnrollment.ts', 'utf8');
const enrollmentGate = readFileSync('src/lib/crypto/deviceEnrollmentGate.ts', 'utf8');
const resync = readFileSync('src/lib/crypto/resyncE2EE.ts', 'utf8');

describe('stable DeviceID architecture', () => {
  it('never generates a replacement from get, rotate or hydrate error paths', () => {
    const rotateBody = currentDevice.match(/export function rotateCurrentDeviceId[\s\S]*?\n}/)?.[0] ?? '';
    const getBody = currentDevice.match(/export function getCurrentDeviceId[\s\S]*?\n}/)?.[0] ?? '';
    const hydrateBody = currentDevice.match(/export async function hydrateDeviceId[\s\S]*?\n}/)?.[0] ?? '';
    expect(rotateBody).not.toContain('generateId()');
    expect(getBody).not.toContain('generateId()');
    expect(hydrateBody).not.toContain('generateId()');
    expect(rotateBody).toContain('DEVICE_ID_REAPPROVAL_REQUIRED');
    expect(hydrateBody).toContain('DEVICE_ID_REAPPROVAL_REQUIRED');
  });

  it('creates a new local identity only behind the explicit enrollment API', () => {
    const explicitBody = currentDevice.match(/export async function beginExplicitDeviceEnrollment[\s\S]*?\n}/)?.[0] ?? '';
    expect(explicitBody).toContain('authorizeExplicitDeviceEnrollment');
    expect(explicitBody).toContain('generateId()');
    expect(explicitBody).toContain('cancelLocalEnrollmentTransition');
  });

  it('bounds and cancels the local server-ID transition', () => {
    expect(currentDevice).toContain('EXPLICIT_ENROLLMENT_TRANSITION_TTL_MS');
    expect(currentDevice).toContain('explicitEnrollmentExpiresAt > Date.now()');
    expect(currentDevice).toContain('SERVER_DEVICE_ID_RE.test(id)');
    expect(currentDevice).toContain('cancelExplicitDeviceEnrollmentAuthorization');

    const scopeBody = currentDevice.match(/export function setCurrentDeviceUserScope[\s\S]*?\n}/)?.[0] ?? '';
    const setterBody = currentDevice.match(/export function setCurrentDeviceId[\s\S]*?\n}/)?.[0] ?? '';
    expect(scopeBody).toContain('cancelLocalEnrollmentTransition();');
    expect(setterBody).toContain('cancelLocalEnrollmentTransition();');
  });

  it('blocks server enrollment unless the one-shot explicit grant is consumed', () => {
    expect(enrollment).toContain('consumeExplicitDeviceEnrollmentAuthorization();');
    expect(enrollment.indexOf('consumeExplicitDeviceEnrollmentAuthorization();'))
      .toBeLessThan(enrollment.indexOf("supabase.rpc('begin_user_device_enrollment'"));
    expect(enrollmentGate).toContain('DEVICE_ENROLLMENT_REQUIRES_EXPLICIT_USER_ACTION');
  });

  it('cannot turn the resync fallback into a ghost server device', () => {
    expect(resync).toContain('beginServerAssignedDeviceEnrollment');
    expect(enrollment).toContain('consumeExplicitDeviceEnrollmentAuthorization();');
  });

  it('ignores the legacy backup value instead of adopting it', () => {
    const backupBody = currentDevice.match(/export function adoptDeviceIdFromBackup[\s\S]*?\n}/)?.[0] ?? '';
    expect(backupBody).toContain('return getCurrentDeviceId();');
    expect(backupBody).not.toContain('setCurrentDeviceId(_legacyId)');
  });
});
