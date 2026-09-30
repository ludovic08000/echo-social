import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260930124046_add_encrypted_message_requests.sql',
  'utf8',
).toLowerCase();
const widget = readFileSync('src/components/ChatWidget.tsx', 'utf8');
const requestHook = readFileSync('src/hooks/useDirectMessageRequests.ts', 'utf8');
const envelope = readFileSync('src/lib/messaging/aegisEnvelope.ts', 'utf8');
const conversationHook = readFileSync('src/hooks/useMessages.ts', 'utf8');

describe('encrypted direct-message request architecture', () => {
  it('keeps request and anti-spam state server-controlled and private', () => {
    expect(migration).toContain('create table if not exists public.direct_message_requests');
    expect(migration).toContain('create table if not exists public.direct_message_request_risk');
    expect(migration).toContain('alter table public.direct_message_requests enable row level security');
    expect(migration).toContain('revoke all on table public.direct_message_requests');
    expect(migration).toContain('revoke all on table public.direct_message_request_risk');
    expect(migration).not.toContain('grant select on table public.direct_message_request_risk');
    expect(migration).toContain("status in ('pending', 'accepted', 'dismissed', 'spam', 'blocked')");
    expect(migration).toContain('sync_direct_message_request_block_state');
    expect(migration).toContain('after insert or delete on public.user_message_blocks');
  });

  it('preserves existing chats and routes only a future first encrypted text', () => {
    expect(migration).toContain("'accepted',\n  first_message.id");
    expect(migration).toContain("v_content_kind := nullif(new.body::jsonb->>'contentkind', '')");
    expect(migration).toContain("raise exception 'message_request_client_update_required'");
    expect(migration).toContain("if v_content_kind <> 'text'");
    expect(migration).toContain("raise exception 'message_request_text_only'");
    expect(migration).toContain("raise exception 'message_request_pending'");
    expect(migration).toContain("raise exception 'message_request_rate_limited'");
    expect(migration).toContain("'dm-request-sender:' || new.sender_id::text");
    expect(migration).toContain('public.aegis_message_block_reason');
    expect(migration).toContain('public.is_user_minor');
    expect(migration).toContain('settings.messages_allowed');
    expect(migration).not.toContain('decrypt');
  });

  it('does not leak reads or permit calls before acceptance', () => {
    expect(migration).toContain('guard_pending_request_read_state');
    expect(migration).toContain(
      "new.delivered_at := coalesce(old.delivered_at, new.delivered_at, now())",
    );
    expect(migration).toContain('guard_pending_request_read_receipt');
    expect(migration).toContain('guard_pending_request_device_copy_read');
    expect(migration).toContain('guard_unaccepted_direct_call');
    expect(migration).toContain("request.status in ('pending', 'spam')");
    expect(migration).toContain("raise exception 'message_request_acceptance_required'");
  });

  it('exposes only masked categories and recipient-controlled actions', () => {
    expect(migration).toContain('create or replace function public.get_direct_message_request_states()');
    expect(migration).toContain("then 'requests'");
    expect(migration).toContain("then 'spam'");
    expect(migration).toContain("then 'outgoing_pending'");
    expect(migration).toContain("p_action not in ('accept', 'dismiss', 'report_spam', 'block')");
    expect(migration).toContain('request.recipient_user_id = v_uid');
    expect(migration).toContain('on conflict (blocker_user_id, blocked_user_id) do nothing');
    expect(requestHook).toContain("'accept' | 'dismiss' | 'report_spam' | 'block'");
  });

  it('wires the inbox, global search, and authenticated content category in the client', () => {
    expect(widget).toContain("'primary' | 'requests' | 'spam'");
    expect(widget).toContain('Rechercher n’importe qui');
    expect(widget).toContain('Vous pouvez lire ce premier message sans envoyer d’accusé de lecture');
    expect(widget).toContain("handleRequestAction('accept')");
    expect(widget).toContain("handleRequestAction('report_spam')");
    expect(widget).toContain('if (!conversationId || !user?.id || !messages?.length || isIncomingRequest) return');
    expect(widget).toContain("conversation.inbox_category === 'draft_request'");
    expect(widget).toContain('conversation.created_by !== user?.id');
    expect(widget).toContain('allowRichContent={!isIncomingRequest}');
    expect(envelope).toContain('contentKind?: AegisContentKind');
    expect(envelope).toContain('|kind:${contentKind}');
    expect(conversationHook).toContain("detail?.reason !== 'aegis-device-copy'");
    expect(conversationHook).toContain('scheduleConversationRefetch(queryClient, userId)');
  });
});
