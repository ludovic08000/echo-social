import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('messaging CI prerequisites', () => {
  it('creates WebAuthn tables and locks down access before the first recovery RPC', () => {
    const sql = readFileSync('supabase/migrations/20260810053000_webauthn_device_rpc_recovery.sql', 'utf8');
    const firstRpc = sql.indexOf('create or replace function public.webauthn_begin_device_registration');
    expect(firstRpc).toBeGreaterThan(0);
    const schema = sql.slice(0, firstRpc);
    for (const name of ['webauthn_device_challenges', 'webauthn_device_credentials', 'webauthn_device_vaults']) {
      expect(schema).toContain(`create table if not exists public.${name}`);
      expect(schema).toContain(`alter table public.${name} enable row level security`);
      expect(schema).toContain(`revoke all on public.${name} from anon, authenticated`);
    }
  });

  it.each([
    '20260805131000_revoke_ios_device_id_collision.sql',
    '20260805133346_f6723fd3-78ae-4981-a796-398123c36a0b.sql',
  ])('does not access retired crypto tables in %s', name => {
    const sql = readFileSync(`supabase/migrations/${name}`, 'utf8');
    expect(sql).not.toMatch(/public\.(e2ee_session_sync|user_device_signatures)\b/);
    expect(sql).toContain('insert into public.invalid_e2ee_devices');
    expect(sql).toContain('where user_id = v_user_id');
    expect(sql).toContain('and device_id = v_device_id');
  });

  it('installs the SDK requested by the Android app without the removed tools package', () => {
    const workflow = readFileSync('.github/workflows/build-libsignal-android.yml', 'utf8');
    const variables = readFileSync('android/variables.gradle', 'utf8');
    const sdk = variables.match(/compileSdkVersion\s*=\s*(\d+)/)?.[1];
    expect(sdk).toBeDefined();
    expect(workflow).toContain(`"platforms;android-${sdk}"`);
    expect(workflow).toMatch(/uses: android-actions\/setup-android@v3\s+with:\s+(?:#[^\n]*\n\s*)?packages: platform-tools\s/);
  });
});
