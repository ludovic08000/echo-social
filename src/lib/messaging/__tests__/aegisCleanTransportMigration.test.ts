import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260730010000_aegis_clean_transport.sql'),
  'utf8',
).toLowerCase();

describe('Aegis clean transport migration', () => {
  it('serializes every call for one stable message UUID before confirmation', () => {
    const lock = sql.indexOf('pg_advisory_xact_lock');
    const existing = sql.indexOf('select message.sender_id, message.aegis_request_digest');
    const membership = sql.indexOf('sender_not_conversation_participant');

    expect(lock).toBeGreaterThan(0);
    expect(existing).toBeGreaterThan(lock);
    expect(membership).toBeGreaterThan(existing);
  });

  it('binds idempotency to the complete immutable request', () => {
    expect(sql).toContain("'conversation_id', p_conversation_id");
    expect(sql).toContain("'sender_user_id', v_uid");
    expect(sql).toContain("'body', p_body");
    expect(sql).toContain("'image_url', nullif(p_image_url, '')");
    expect(sql).toContain("'extra', coalesce(p_extra, '{}'::jsonb)");
    expect(sql).toContain("'sender_device_id', trim(coalesce(p_sender_device_id, ''))");
    expect(sql).toContain("'route_version', p_route_version");
    expect(sql).toContain("'copies', v_normalized_copies");
    expect(sql).toContain("digest(");
    expect(sql).toContain("'sha256'");
  });

  it('confirms only an exact stored digest and returns a structured receipt', () => {
    expect(sql).toContain('v_existing_digest = v_request_digest');
    expect(sql).not.toContain('v_existing_body = p_body');
    expect(sql).toContain("'state', 'committed'");
    expect(sql).toContain("'message_id', p_message_id");
    expect(sql).toContain("'request_digest', v_request_digest");
    expect(sql).toContain("'existing', true");
    expect(sql).toContain("'existing', false");
  });

  it('stores the digest in the same transaction as parent and device copies', () => {
    expect(sql).toContain('add column if not exists aegis_request_digest text');
    expect(sql).toContain('archive_body, aegis_route_version,\n    aegis_request_digest');
    expect(sql).toContain('insert into public.message_device_copies');
    expect(sql).toContain('notify pgrst, \'reload schema\'');
  });
});
