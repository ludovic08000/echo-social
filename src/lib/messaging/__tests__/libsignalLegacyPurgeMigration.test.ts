import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260915213000_purge_legacy_message_crypto.sql',
  'utf8',
).toLowerCase();

describe('guarded Libsignal-only database purge', () => {
  it('aborts unless every explicitly approved destructive count still matches', () => {
    for (const guard of [
      'v_legacy_copies <> 43',
      'v_supported_copies <> 0',
      'v_target_messages <> 56',
      'v_retry_targets <> 145',
      'v_inbox_targets <> 43',
      'v_all_archives <> 32',
      'v_view_once_consumptions <> 0',
      'v_view_once_payloads <> 0',
      'v_message_deletions <> 0',
      'v_message_reactions <> 0',
      'v_x3dh_initial <> 1',
      'v_device_spk <> 12',
      'v_device_opk <> 589',
      'v_user_spk <> 74',
      'v_devices <> 20',
      'v_devices_without_bundle <> 18',
      'v_active_devices_without_bundle <> 11',
      'v_bundles <> 40',
      'v_cron_jobs <> 2',
    ]) {
      expect(migration).toContain(guard);
    }
    expect(migration).toContain('libsignal_purge_count_drift');
  });

  it('allows only the approved production snapshot or a completely empty fresh install', () => {
    expect(migration).toContain("values ('production')");
    expect(migration).toContain("values ('fresh')");
    expect(migration).toContain("mode in ('production', 'fresh')");
    expect(migration).toContain("if to_regclass('cron.job') is null then");
    expect(migration).toContain('v_cron_jobs := 0');
    expect(migration).toContain(
      "case when v_mode = 'production' then 145 else 0 end",
    );
    expect(migration).toContain(
      "case when v_mode = 'production' then 18 else 0 end",
    );
  });

  it('deletes only approved message rows and keeps the Libsignal pool', () => {
    expect(migration).toContain('using _aegis_legacy_message_target target');
    expect(migration).toContain('using _aegis_legacy_copy_target target');
    expect(migration).not.toContain('delete from public.device_libsignal_prekey_bundles;');
    expect(migration).not.toContain('sealed_sender_messages');
    expect(migration).not.toContain('sender_key_distribution');
    expect(migration).not.toContain('e2ee_session_sync');
  });

  it('turns the transitional copy check into an enforced Libsignal invariant', () => {
    expect(migration).toContain('libsignal_purge_copy_constraint_missing');
    expect(migration).toContain(
      'validate constraint message_device_copies_libsignal_wire_check',
    );
    expect(migration).toContain('constraint_record.convalidated = true');
    expect(migration).toContain('libsignal_purge_copy_constraint_not_validated');
  });

  it('replaces critical routing and revocation RPCs before removing old prekeys', () => {
    const sesame = migration.indexOf(
      'create or replace function public.get_sesame_device_list',
    );
    const revoke = migration.indexOf(
      'create or replace function public.revoke_user_device',
    );
    const dropPrekeys = migration.indexOf('drop table public.device_signed_prekeys');

    expect(sesame).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeGreaterThan(sesame);
    expect(dropPrekeys).toBeGreaterThan(revoke);
    expect(migration).toContain('from public.device_libsignal_prekey_bundles bundle');
    expect(migration).toContain('delete from public.device_libsignal_prekey_bundles bundle');
  });

  it('removes old RPCs and tables without an unbounded drop', () => {
    for (const table of [
      'device_signed_prekeys',
      'device_one_time_prekeys',
      'device_prekey_repair_requests',
      'aegis_x3dh_initial_replay',
      'x3dh_replay_ledger',
    ]) {
      expect(migration).toContain(`drop table public.${table}`);
    }
    expect(migration).toContain('drop table if exists public.user_signed_prekeys');
    expect(migration).not.toContain(
      'drop function if exists public.trg_bump_aegis_signature_route()',
    );
    expect(migration).not.toMatch(/drop\s+(table|function)[^;]*\bcascade\b/);
    expect(migration).toContain("'%publish_device_signed_prekey%'");
    expect(migration).toContain("'%claim_x3dh_initial%'");
    expect(migration).toContain("notify pgrst, 'reload schema'");
  });
});
