import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260723120000_aegis_server_alignment_and_exact_delivery.sql',
  ),
  'utf8',
).toLowerCase();

describe('Aegis server alignment migration', () => {
  it('enrolls the authenticated installation without reviving a revoked DeviceID', () => {
    expect(migration).toContain('create or replace function public.register_user_device_safe');
    expect(migration).toContain('p_device_name text default null');
    expect(migration).toContain('p_device_public_key text default null');
    expect(migration).toContain("'device_registered_and_approved'");
    expect(migration).toContain('v_existing.revoked_at is not null');
    expect(migration).toContain("v_existing.approval_status = 'rejected'");
  });

  it('keeps inactivity cleanup unable to revoke devices', () => {
    expect(migration).toContain('create or replace function public.cleanup_current_user_stale_devices');
    expect(migration).toContain("'manual_revocation_only'");
    expect(migration).toContain("'devices_deactivated', 0");
  });

  it('asserts exact coverage from the parent so zero-copy inserts cannot bypass it', () => {
    expect(migration).toContain('drop trigger if exists aegis_require_all_device_copies');
    expect(migration).toContain('create constraint trigger aegis_require_exact_device_copies');
    expect(migration).toContain('after insert on public.messages');
    expect(migration).toContain("'e2ee_device_copies_unavailable'");
    expect(migration).toContain('v_missing_count');
    expect(migration).toContain('v_unexpected_count');
    expect(migration).toContain('v_duplicate_count');
  });

  it('does not erase messages while aligning the server', () => {
    expect(migration).not.toMatch(/\btruncate\s+table\s+public\.messages\b/);
    expect(migration).not.toMatch(/\bdelete\s+from\s+public\.messages\b/);
  });
});
