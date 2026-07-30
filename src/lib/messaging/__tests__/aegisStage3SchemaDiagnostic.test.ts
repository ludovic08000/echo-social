import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Aegis stage 3 schema diagnostic', () => {
  it('points server repair at the account-authorized device migration', () => {
    const registration = readFileSync(
      resolve(process.cwd(), 'src/hooks/useDeviceRegistration.ts'),
      'utf8',
    );

    expect(registration).toContain(
      "migration: '20260730020000_aegis_account_authorized_devices.sql'",
    );
    expect(registration).not.toContain(
      "migration: '20260728100000_sesame_per_device_identity.sql'",
    );
  });
});
