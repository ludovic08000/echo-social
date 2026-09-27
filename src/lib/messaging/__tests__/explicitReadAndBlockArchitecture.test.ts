import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const migrationPath = 'supabase/migrations/20260927210000_explicit_message_blocks_and_read_receipts.sql';

describe('explicit read receipts and user block architecture', () => {
  it('keeps block relations private and exposes only owner-controlled mutation', () => {
    const migration = read(migrationPath);

    expect(migration).toContain('create table if not exists public.user_message_blocks');
    expect(migration).toContain('alter table public.user_message_blocks enable row level security');
    expect(migration).toContain('using (blocker_user_id = auth.uid())');
    expect(migration).toContain('revoke all on table public.user_message_blocks from public, anon, authenticated');
    expect(migration).toContain('grant select on table public.user_message_blocks to authenticated');
    expect(migration).not.toContain('grant select, insert, delete on table public.user_message_blocks');
    expect(migration).toContain('create or replace function public.aegis_set_user_message_block');
    expect(migration).toContain('v_uid uuid := auth.uid()');
  });

  it('rechecks a block inside the atomic send and omits every blocked capsule', () => {
    const migration = read(migrationPath);

    expect(migration).toContain('public.aegis_message_block_reason(v_uid, participant.user_id)');
    expect(migration).toContain("when peer.block_reason = 'recipient_block' then 'BLOCKED_SENDER'");
    expect(migration).toContain("when peer.block_reason = 'sender_block' then 'BLOCKED_BY_SELF'");
    expect(migration).toContain("when peer.block_reason is not null then '[]'::jsonb");
    expect(migration).toContain("and recipient_state.state <> 'blocked'");
    expect(migration).toContain("'blocked_recipients', v_blocked_recipients");
  });

  it('checks encrypted parent visibility without being bypassed by private-state RLS', () => {
    const migration = read(migrationPath);

    expect(migration).toContain('create or replace function public.aegis_can_view_message');
    expect(migration).toContain('security definer');
    expect(migration).toContain('recipient_state.recipient_user_id = auth.uid()');
    expect(migration).toContain('public.aegis_can_view_message(');
  });

  it('advances delivered and read state only through the authenticated device ACK', () => {
    const migration = read(migrationPath);

    expect(migration).toContain('create table if not exists public.message_recipient_states');
    expect(migration).toContain('grant select on table public.message_recipient_states to authenticated');
    expect(migration).not.toContain('grant insert on table public.message_recipient_states to authenticated');
    expect(migration).not.toContain('grant update on table public.message_recipient_states to authenticated');
    expect(migration).toContain('create or replace function public.aegis_ack_device_messages');
    expect(migration).toContain('where device.device_id = v_device_id');
    expect(migration).toContain("set state = case when p_mark_read then 'read' else 'delivered' end");
    expect(migration).toContain('insert into public.message_read_receipts');
  });

  it('emits read ACKs only for visible, decrypted, non-view-once messages', () => {
    const widget = read('src/components/ChatWidget.tsx');

    expect(widget).toContain("if (document.visibilityState !== 'visible') return;");
    expect(widget).toContain('message.view_once !== true');
    expect(widget).toContain('decryptedCacheRef.current.has(message.id)');
    expect(widget).toContain('acknowledgeAegisMessages(user.id, readableIncomingIds, true)');
  });
});
