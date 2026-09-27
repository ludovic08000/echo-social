import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260924120000_require_recoverable_message_archives.sql'),
  'utf8',
).toLowerCase();

describe('recoverable Aegis archive boundary', () => {
  it('rejects ordinary messages without a context-bound v2 archive', () => {
    expect(sql).toContain('create or replace function public.is_supported_aegis_archive');
    expect(sql).toContain("coalesce(v_payload ->> 'v', '') <> '2'");
    expect(sql).toContain("v_payload ->> 'context'");
    expect(sql).toContain('p_message_id::text');
    expect(sql).toContain("raise exception 'aegis_archive_required'");
    expect(sql).toContain("new.body_kind = 'multi_device'");
  });

  it('keeps the intentional view-once exception and validates supplied archives', () => {
    expect(sql).toContain('not coalesce(new.view_once, false)');
    expect(sql).toContain('if new.archive_body is not null');
    expect(sql).toContain("raise exception 'aegis_archive_invalid'");
    expect(sql).toContain('enforce_valid_personal_message_archive');
  });
});
