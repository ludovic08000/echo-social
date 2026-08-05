import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260805164500_require_active_spk_for_device_routing.sql',
  'utf8',
).toLowerCase();

describe('iOS device routing hardening migration', () => {
  it('requires an active non-expired signed prekey for routability', () => {
    expect(migration).toContain('device.crypto_invalid_at is null');
    expect(migration).toContain('from public.device_signed_prekeys spk');
    expect(migration).toContain('spk.is_active = true');
    expect(migration).toContain('spk.expires_at is null or spk.expires_at > now()');
  });

  it('keeps devices without a signed prekey in repairing state', () => {
    expect(migration).toContain("else 'repairing'");
    expect(migration).toContain("else 'signed_prekey_required'");
  });
});
