import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const app = read('src/App.tsx');
const registration = read('src/hooks/useDeviceRegistration.ts');
const x3dh = read('src/lib/crypto/x3dh.ts');
const deviceTrust = read('src/lib/crypto/deviceLinkTrust.ts');
const devicesPanel = read('src/components/settings/DevicesPanel.tsx');
const migration = read(
  'supabase/migrations/20260722120000_manual_device_revocation_only.sql',
).toLowerCase();

describe('manual-only DeviceID revocation policy', () => {
  it('has no automatic inactive-device cleanup in the client lifecycle', () => {
    expect(app).not.toContain("rpc('cleanup_current_user_stale_devices'");
    expect(registration).not.toContain("rpc('cleanup_stale_user_devices'");
    expect(registration).not.toContain('quarantineInvalidApprovedDevices');
  });

  it('repairs an invalid SPK without quarantining the whole DeviceID', () => {
    expect(x3dh).toContain("rpc('quarantine_own_invalid_device_spk'");
    expect(x3dh).not.toContain("rpc('quarantine_own_invalid_device',");
    expect(deviceTrust).not.toContain("rpc('quarantine_own_invalid_device'");
  });

  it('keeps the explicit connected-devices menu as the revocation entry point', () => {
    expect(devicesPanel).toContain("rpc('revoke_user_device'");
    expect(devicesPanel).toContain('Révoquer cet appareil ?');
    expect(devicesPanel).toContain('onClick={() => void handleRevoke(dev)}');
  });

  it('neutralizes legacy cleanup RPCs and rejects non-manual revocation in SQL', () => {
    expect(migration).toContain('manual_revocation_only');
    expect(migration).toContain('manual_device_revocation_required');
    expect(migration).toContain('device_revocation_requires_manual_menu');
    expect(migration).toContain("coalesce(new.revoke_reason, '') <> 'manual'");
    expect(migration).toContain('revoke_reason = null');
    expect(migration).toContain('devices_deactivated\', 0');
  });
});
