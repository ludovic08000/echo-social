import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260929141820_accelerate_aegis_send_commit.sql',
  ),
  'utf8',
).toLowerCase();

describe('Aegis atomic archive commit', () => {
  it('persists only the sender opaque archive in the message transaction', () => {
    expect(sql).toContain('create trigger persist_aegis_sender_message_archive');
    expect(sql).toContain('after insert');
    expect(sql).toContain('insert into public.message_archives');
    expect(sql).toContain('new.sender_id');
    expect(sql).toContain('new.archive_body');
    expect(sql).toContain('public.is_supported_aegis_archive(new.archive_body, new.id)');
    expect(sql).toContain('on conflict (message_id, user_id) do nothing');
    expect(sql).not.toContain('on conflict (message_id, user_id) do update');
  });

  it('returns an exact durability proof in the authoritative commit receipt', () => {
    expect(sql).toContain("'archive_durable', coalesce(v_archive_durable, false)");
    expect(sql).toContain('archive.user_id = message.sender_id');
    expect(sql).toContain('archive.archive_body = message.archive_body');
    expect(sql).toContain('coalesce(message.view_once, false)');
  });

  it('keeps helper execution private and uses an explicit empty search path', () => {
    expect(sql).toContain('security definer');
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain(
      'revoke all on function public.persist_aegis_sender_message_archive()',
    );
    expect(sql).toContain('from public, anon, authenticated');
  });
});
