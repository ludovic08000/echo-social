import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deviceApi = readFileSync('src/lib/api/deviceApi.ts', 'utf8');
const reuse = readFileSync('src/platforms/ios/iosDeviceReuse.ts', 'utf8');

describe('iOS silent re-enrollment guard', () => {
  it('treats a current or Keychain-anchored DeviceID as continuity evidence', () => {
    expect(reuse).toContain('resolveExistingIosDevice');
    expect(reuse).toContain("source: 'keychain-anchor'");
    expect(reuse).not.toContain('generateId');
  });

  it('restores the exact vault or enters recovery before explicit enrollment', () => {
    const continuity = deviceApi.indexOf('resolveExistingIosDevice(userId)');
    const recovery = deviceApi.indexOf('DEVICE_VAULT_RECOVERY_REQUIRED', continuity);
    const enrollment = deviceApi.indexOf("beginExplicitDeviceEnrollment('user_requested_new_device')");
    expect(continuity).toBeGreaterThanOrEqual(0);
    expect(recovery).toBeGreaterThan(continuity);
    expect(enrollment).toBeGreaterThan(recovery);
    expect(deviceApi.slice(continuity, enrollment)).toContain('ensureIosDeviceVaultRestored(userId)');
  });
});
