import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260924153000_harden_signal_style_recovery_boundaries.sql',
  ),
  'utf8',
).toLowerCase();

describe('Signal-style zero-access recovery boundaries', () => {
  it('makes conversation archive keys owner-scoped and write-once', () => {
    expect(sql).toContain('is_supported_conversation_archive_key');
    expect(sql).toContain("octet_length(decode(p_wrapped_key, 'base64')) = 60");
    expect(sql).toContain('grant select, insert on table public.conversation_archive_keys');
    expect(sql).toContain('drop policy if exists "archive_keys_owner_update"');
    expect(sql).toContain('drop policy if exists "archive_keys_owner_delete"');
    expect(sql).toContain('public.is_conversation_participant');
  });

  it('allows personal archives only for a participant of the parent conversation', () => {
    expect(sql).toContain('grant select, insert on table public.message_archives');
    expect(sql).toContain('from public.messages as parent_message');
    expect(sql).toContain('parent_message.id = message_archives.message_id');
    expect(sql).toContain('user_id = (select auth.uid())');
  });

  it('removes unnecessary definer rights from archive-key reads', () => {
    expect(sql).toContain('create or replace function public.get_user_archive_keys()');
    expect(sql).toContain('security invoker');
    expect(sql).toContain('revoke all on function public.get_user_archive_keys() from public, anon');
  });

  it('validates exact recovery-vault salt and nonce sizes before storage', () => {
    expect(sql).toContain('enforce_valid_aegis_recovery_vault_envelope');
    expect(sql).toContain('octet_length(v_salt) <> 32');
    expect(sql).toContain('octet_length(v_nonce) <> 12');
    expect(sql).toContain('octet_length(v_ciphertext) <= 16');
    expect(sql).toContain("raise exception 'invalid_recovery_vault_payload'");
  });
});
