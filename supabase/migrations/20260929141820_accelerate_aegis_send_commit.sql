-- Persist the sender's recovery archive in the same transaction as the
-- authoritative Aegis message insert. The browser already sends this opaque
-- ciphertext as messages.archive_body; duplicating it locally avoids a
-- post-commit SELECT/UPSERT/SELECT/RPC chain without exposing plaintext.

create or replace function public.persist_aegis_sender_message_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.body_kind = 'multi_device'
     and not coalesce(new.view_once, false)
     and public.is_supported_aegis_archive(new.archive_body, new.id) then
    insert into public.message_archives (
      message_id,
      user_id,
      archive_body
    ) values (
      new.id,
      new.sender_id,
      new.archive_body
    )
    on conflict (message_id, user_id) do nothing;
  end if;

  return new;
end;
$function$;

revoke all on function public.persist_aegis_sender_message_archive()
from public, anon, authenticated;

drop trigger if exists persist_aegis_sender_message_archive
on public.messages;
create trigger persist_aegis_sender_message_archive
  after insert
  on public.messages
  for each row
  execute function public.persist_aegis_sender_message_archive();

comment on function public.persist_aegis_sender_message_archive() is
  'Atomically copies the sender opaque Aegis recovery archive into message_archives.';

-- The receipt is the compatibility boundary: upgraded clients can finish as
-- soon as the transaction returns archive_durable=true, while older rows or
-- older deployments naturally keep using the existing client-side repair.
create or replace function public.aegis_build_message_commit_receipt(
  p_message_id uuid,
  p_request_digest text,
  p_existing boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_total integer := 0;
  v_blocked integer := 0;
  v_blocked_recipients jsonb := '[]'::jsonb;
  v_delivery_state text := 'sent';
  v_archive_durable boolean := false;
begin
  select
    count(*),
    count(*) filter (where recipient_state.state = 'blocked'),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'user_id', recipient_state.recipient_user_id,
          'reason', recipient_state.blocked_reason
        )
        order by recipient_state.recipient_user_id
      ) filter (where recipient_state.state = 'blocked'),
      '[]'::jsonb
    )
  into v_total, v_blocked, v_blocked_recipients
  from public.message_recipient_states recipient_state
  where recipient_state.message_id = p_message_id;

  v_delivery_state := case
    when v_total > 0 and v_blocked = v_total then 'blocked'
    when v_blocked > 0 then 'partial'
    else 'sent'
  end;

  select
    coalesce(message.view_once, false)
    or (
      public.is_supported_aegis_archive(message.archive_body, message.id)
      and exists (
        select 1
        from public.message_archives archive
        where archive.message_id = message.id
          and archive.user_id = message.sender_id
          and archive.archive_body = message.archive_body
      )
    )
  into v_archive_durable
  from public.messages message
  where message.id = p_message_id;

  return jsonb_build_object(
    'state', 'committed',
    'message_id', p_message_id,
    'request_digest', p_request_digest,
    'existing', p_existing,
    'delivery_state', v_delivery_state,
    'blocked_recipients', v_blocked_recipients,
    'archive_durable', coalesce(v_archive_durable, false)
  );
end;
$function$;

revoke all on function public.aegis_build_message_commit_receipt(uuid, text, boolean)
from public, anon, authenticated;
