import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260806090000_require_explicit_device_approval.sql',
  'utf8',
).toLowerCase();

describe('explicit device approval migration', () => {
  it('installs the authenticated approval RPC', () => {
    expect(migration).toContain('create or replace function public.approve_user_device');
    expect(migration).toContain('v_uid uuid := auth.uid()');
    expect(migration).toContain('device.user_id = v_uid');
    expect(migration).toContain('grant execute on function public.approve_user_device(text) to authenticated');
  });

  it('requires a completed, non-cancelled enrollment challenge', () => {
    expect(migration).toContain('from public.device_enrollment_challenges challenge');
    expect(migration).toContain('challenge.consumed_at is not null');
    expect(migration).toContain('challenge.cancelled_at is null');
  });

  it('approves only a device with complete authorization material', () => {
    expect(migration).toContain("approval_status = 'approved'");
    expect(migration).toContain("nullif(trim(device.device_public_key), '') is not null");
    expect(migration).toContain("nullif(trim(device.device_signing_key), '') is not null");
    expect(migration).toContain("nullif(trim(device.device_authorization_signature), '') is not null");
    expect(migration).toContain("'code', 'device_approved'");
  });
});
