import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

describe('messaging PIN recovery safety contract', () => {
  it('never sends the messaging PIN to Lovable Cloud', () => {
    const hook = source('src/hooks/useChatPin.ts');
    const edgeFunction = source('supabase/functions/verify-chat-pin/index.ts');

    expect(hook).toContain("body: { action: 'register-local-recovery' }");
    expect(hook).not.toMatch(/register-local-recovery'\s*,\s*pin/);
    expect(edgeFunction).toContain('const { action, code } = body;');
    expect(edgeFunction).toContain('PIN_LOCAL_ONLY');
  });

  it('keeps an email reset isolated from messages and Aegis/Libsignal identities', () => {
    const edgeFunction = source('supabase/functions/verify-chat-pin/index.ts');
    const resetBlock = between(
      edgeFunction,
      'if (action === "confirm-reset")',
      'return new Response(JSON.stringify({ error: `Action inconnue:',
    );

    const forbiddenTargets = [
      '.from("messages")',
      '.from("user_devices")',
      '.from("user_public_keys")',
      '.from("user_backups")',
      'libsignal',
      'identity-keys',
      'wrapped-keys',
    ];

    for (const target of forbiddenTargets) {
      expect(resetBlock).not.toContain(target);
    }
  });

  it('limits local PIN removal to the PIN verifier store', () => {
    const hook = source('src/hooks/useChatPin.ts');
    const removal = between(
      hook,
      'async function removeLocalPin',
      'async function verifyLocalPin',
    );

    expect(removal).toContain('tx.objectStore(STORE).delete(userId)');
    expect(removal).toContain('secureRemoveSecret');
    expect(removal).not.toContain('wrapped-keys');
    expect(removal).not.toContain('identity-keys');
    expect(removal).not.toContain('libsignal');
  });

  it('requires the account Master Key to open portable PIN continuity', () => {
    const vault = source('src/lib/crypto/pinContinuityVault.ts');

    expect(vault).toContain('getSessionMasterKey');
    expect(vault).toContain("name: 'AES-GCM'");
    expect(vault).toContain("if (!masterKey) return 'locked'");
    expect(vault).toContain("if (status === 'locked') return 'master_key_unavailable'");
    expect(vault).not.toContain('pin_hash');
    expect(vault).not.toContain('reset_code_hash');
  });

  it('authenticates the account before accepting any reset action', () => {
    const edgeFunction = source('supabase/functions/verify-chat-pin/index.ts');
    const authCheck = edgeFunction.indexOf('userClient.auth.getUser()');
    const bodyRead = edgeFunction.indexOf('const body = await req.json()');
    const resetAction = edgeFunction.indexOf('if (action === "request-reset")');

    expect(authCheck).toBeGreaterThanOrEqual(0);
    expect(bodyRead).toBeGreaterThan(authCheck);
    expect(resetAction).toBeGreaterThan(bodyRead);
  });

  it('keeps reset challenges and mutation RPCs server-only', () => {
    const migration = source(
      'supabase/migrations/20260923192452_harden_chat_pin_recovery.sql',
    );

    expect(migration).toContain(
      'alter table public.aegis_chat_pin_reset_challenges enable row level security',
    );
    expect(migration).toContain(
      'revoke all on table public.aegis_chat_pin_reset_challenges\nfrom public, anon, authenticated',
    );
    expect(migration).toContain(
      'revoke all on table public.user_chat_pins from public, anon, authenticated',
    );
    expect(migration).toContain(
      'grant execute on function public.aegis_chat_pin_reset_commit',
    );
    expect(migration).toContain('to service_role;');
    expect(migration).not.toMatch(
      /grant execute on function public\.aegis_chat_pin_reset_(?:begin|authorize|commit)[^;]*?to authenticated/i,
    );
  });

  it('binds email authorization to fresh possession of a ready Aegis device', () => {
    const migration = source(
      'supabase/migrations/20260923192452_harden_chat_pin_recovery.sql',
    );
    const authorization = between(
      migration,
      'create or replace function public.aegis_chat_pin_reset_authorize(',
      'create or replace function public.aegis_chat_pin_reset_commit(',
    );

    expect(authorization).toContain("p_device_id !~ '^dev_[a-f0-9]{32}$'");
    expect(authorization).toContain('p_device_proof_issued_at_ms < v_now_ms - 120000');
    expect(authorization).toContain("v_proof_payload := 'forsure-aegis-pin-reset|'");
    expect(authorization).toContain('public.aegis_verify_account_binding(');
    expect(authorization).toContain('public.aegis_verify_device_authorization(');
    expect(authorization).toContain('public.aegis_verify_ed25519(');
    expect(authorization).toContain('device.lifecycle_status = \'ready\'');
    expect(authorization).toContain('device.routing_status = \'ready\'');
    expect(authorization).toContain('device.libsignal_device_number between 1 and 127');
    expect(authorization).toContain('public.device_libsignal_prekey_bundles');
  });

  it('records a wrong email code atomically under the challenge row lock', () => {
    const migration = source(
      'supabase/migrations/20260923192452_harden_chat_pin_recovery.sql',
    );
    const authorization = between(
      migration,
      'create or replace function public.aegis_chat_pin_reset_authorize(',
      'create or replace function public.aegis_chat_pin_reset_commit(',
    );

    expect(authorization).toContain('for update;');
    expect(authorization).toContain('v_attempts := least(v_row.failed_attempts + 1, 5)');
    expect(authorization).toContain('failed_attempts = v_attempts');
    expect(authorization).toContain("'attempts_remaining', greatest(0, 5 - v_attempts)");
    expect(authorization).not.toContain('aegis_chat_pin_reset_record_failure');
  });

  it('replaces only the PIN envelope through a generation-checked transaction', () => {
    const migration = source(
      'supabase/migrations/20260923192452_harden_chat_pin_recovery.sql',
    );
    const commit = between(
      migration,
      'create or replace function public.aegis_chat_pin_reset_commit(',
      'create or replace function public.aegis_pin_continuity_state()',
    );

    expect(commit.match(/for update;/g)).toHaveLength(2);
    expect(commit).toContain('v_current_generation is distinct from p_expected_generation');
    expect(commit).toContain('v_next_generation := v_current_generation + 1');
    expect(commit).toContain('update public.aegis_pin_continuity_vault');
    expect(commit).toContain('generation = v_next_generation');
    expect(commit).toContain('consumed_at = v_now');

    for (const table of [
      'messages',
      'user_devices',
      'user_public_keys',
      'user_backups',
      'device_libsignal_prekey_bundles',
    ]) {
      expect(commit).not.toMatch(
        new RegExp(`(?:insert\\s+into|update|delete\\s+from)\\s+public\\.${table}\\b`, 'i'),
      );
    }
  });

  it('prevents ordinary PIN setup from overwriting an existing generation', () => {
    const migration = source(
      'supabase/migrations/20260923192452_harden_chat_pin_recovery.sql',
    );
    const upsert = between(
      migration,
      'create or replace function public.aegis_pin_continuity_upsert(',
      '-- The old table remains as a compatibility marker',
    );

    expect(upsert).toContain('on conflict (user_id) do nothing');
    expect(upsert).toContain('get diagnostics v_inserted = row_count');
    expect(upsert).not.toContain('do update');
  });

  it('serializes concurrent reset requests before a challenge row exists', () => {
    const migration = source(
      'supabase/migrations/20260923192452_harden_chat_pin_recovery.sql',
    );
    const beginReset = between(
      migration,
      'create or replace function public.aegis_chat_pin_reset_begin(',
      'create or replace function public.aegis_chat_pin_reset_authorize(',
    );

    expect(beginReset).toContain(
      'perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0))',
    );
    expect(beginReset).toContain('from public.aegis_pin_continuity_vault vault');
    expect(beginReset).not.toContain('from public.user_chat_pins pin');
    expect(beginReset).toContain("'code', 'SEND_COOLDOWN'");
    expect(beginReset).toContain("'code', 'BURST_LIMIT_REACHED'");
    expect(beginReset).toContain("'code', 'DAILY_LIMIT_REACHED'");
  });
});
