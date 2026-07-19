import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260719220000_aegis_resilient_device_routes.sql'),
  'utf8',
).toLowerCase();

describe('Aegis resilient route SQL contract', () => {
  it('backfills canonical roots for existing authenticated development accounts', () => {
    expect(migration).toContain('insert into public.user_identity_roots');
    expect(migration).toContain('join public.user_public_keys');
    expect(migration).toContain('perform public.ensure_primary_device_exists');
  });

  it('reactivates an approved stale route when that device checks in again', () => {
    expect(migration).toContain('trg_clear_stale_device_on_activity');
    expect(migration).toContain('new.stale_at := null');
    expect(migration).toContain("last_seen_at >= now() - interval '90 days'");
  });

  it('accepts only canonical copies while requiring participant coverage', () => {
    expect(migration).toContain('public.get_signed_device_list(cp.user_id)');
    expect(migration).toContain("raise exception 'e2ee_invalid_device_copy'");
    expect(migration).toContain("raise exception 'e2ee_participant_route_unavailable'");
    expect(migration).toContain('cp.user_id <> v_uid');
  });

  it('does not restore the all-advertised-devices equality check', () => {
    expect(migration).not.toContain('v_copies_count <> v_expected_count');
    expect(migration).not.toContain("raise exception 'e2ee_device_list_stale'");
  });
});
