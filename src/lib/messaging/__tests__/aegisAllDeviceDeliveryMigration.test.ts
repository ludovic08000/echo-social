import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260720223000_aegis_all_device_delivery_and_auto_enrollment.sql',
  ),
  'utf8',
).toLowerCase();

describe('Aegis all-device delivery SQL contract', () => {
  it('approves a newly authenticated device in the registration transaction', () => {
    expect(migration).toContain('create or replace function public.register_user_device_safe');
    expect(migration).toContain("approval_status = 'approved'");
    expect(migration).toContain("'device_registered_and_approved'");
    expect(migration).toContain('perform public.ensure_primary_device_exists(v_uid)');
  });

  it('never silently reactivates a revoked or rejected routing identity', () => {
    expect(migration).toContain('v_existing.revoked_at is not null');
    expect(migration).toContain("v_existing.approval_status = 'rejected'");
    expect(migration).toContain("'device_revoked_or_rejected'");
  });

  it('defers the all-device assertion until every capsule row is present', () => {
    expect(migration).toContain('create constraint trigger aegis_require_all_device_copies');
    expect(migration).toContain('deferrable initially deferred');
    expect(migration).toContain('public.get_signed_device_list(cp.user_id)');
    expect(migration).toContain("raise exception 'e2ee_device_list_stale'");
  });
});
