import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve('supabase/migrations/20260728150000_aegis_durable_device_inbox.sql'),
  'utf8',
);

describe('Aegis durable server inbox migration', () => {
  it('authenticates sync and returns only the current device pending queue', () => {
    expect(sql).toContain('create or replace function public.aegis_sync_device');
    expect(sql).toContain('copy.recipient_user_id = v_uid');
    expect(sql).toContain('copy.recipient_device_id = v_device_id');
    expect(sql).toContain('copy.delivered_at is null');
    expect(sql).toContain('order by copy.created_at, copy.id');
  });

  it('acknowledges only envelopes owned by the authenticated device', () => {
    expect(sql).toContain('create or replace function public.aegis_ack_device_messages');
    expect(sql).toContain('copy.recipient_user_id = v_uid');
    expect(sql).toContain('copy.recipient_device_id = v_device_id');
    expect(sql).toContain('copy.message_id = any(p_message_ids)');
  });

  it('does not expose inbox pruning to clients', () => {
    expect(sql).toContain('auth.role() <> \'service_role\'');
    expect(sql).toContain('revoke all on function public.aegis_prune_device_inbox()');
    expect(sql).toContain('grant execute on function public.aegis_prune_device_inbox()');
    expect(sql).toContain('to service_role');
  });
});
