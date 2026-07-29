begin;

-- Aegis Server durable inbox. The existing aegis_send_message RPC atomically
-- creates one encrypted message_device_copies row per active device. These
-- functions expose those rows as an ordered, authenticated delivery queue.

create index if not exists idx_mdc_aegis_pending_device
on public.message_device_copies (
  recipient_user_id,
  recipient_device_id,
  created_at,
  id
)
where delivered_at is null;

create or replace function public.aegis_sync_device(
  p_device_id text,
  p_limit integer default 100
)
returns table (
  copy_id uuid,
  message_id uuid,
  conversation_id uuid,
  sender_user_id uuid,
  sender_device_id text,
  encrypted_body text,
  parent_body text,
  image_url text,
  document_url text,
  document_name text,
  document_mime text,
  document_size_bytes integer,
  archive_body text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = v_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
  ) then
    raise exception 'E2EE_DEVICE_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  update public.user_devices device
  set last_seen_at = now(),
      updated_at = now()
  where device.user_id = v_uid
    and device.device_id = v_device_id;

  return query
  select
    copy.id,
    copy.message_id,
    message.conversation_id,
    copy.sender_user_id,
    copy.sender_device_id,
    copy.encrypted_body,
    message.body,
    message.image_url,
    message.document_url,
    message.document_name,
    message.document_mime,
    message.document_size_bytes,
    message.archive_body,
    copy.created_at
  from public.message_device_copies copy
  join public.messages message on message.id = copy.message_id
  where copy.recipient_user_id = v_uid
    and copy.recipient_device_id = v_device_id
    and copy.delivered_at is null
    and message.body_kind = 'multi_device'
  order by copy.created_at, copy.id
  limit v_limit;
end;
$$;

revoke all on function public.aegis_sync_device(text, integer)
from public, anon;
grant execute on function public.aegis_sync_device(text, integer)
to authenticated;

create or replace function public.aegis_ack_device_messages(
  p_device_id text,
  p_message_ids uuid[],
  p_mark_read boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_updated integer := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if coalesce(array_length(p_message_ids, 1), 0) = 0
     or array_length(p_message_ids, 1) > 250 then
    raise exception 'AEGIS_ACK_BATCH_INVALID' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = v_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
  ) then
    raise exception 'E2EE_DEVICE_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  update public.message_device_copies copy
  set delivered_at = coalesce(copy.delivered_at, now()),
      read_at = case
        when p_mark_read then coalesce(copy.read_at, now())
        else copy.read_at
      end
  where copy.recipient_user_id = v_uid
    and copy.recipient_device_id = v_device_id
    and copy.message_id = any(p_message_ids);

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.aegis_ack_device_messages(text, uuid[], boolean)
from public, anon;
grant execute on function public.aegis_ack_device_messages(text, uuid[], boolean)
to authenticated;

-- Keep confirmed envelopes long enough for diagnostics and multi-tab races.
-- This function is intended for Supabase Cron/service-role execution.
create or replace function public.aegis_prune_device_inbox()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  delete from public.message_device_copies copy
  where copy.delivered_at < now() - interval '30 days'
     or copy.created_at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.aegis_prune_device_inbox()
from public, anon, authenticated;
grant execute on function public.aegis_prune_device_inbox()
to service_role;

notify pgrst, 'reload schema';
commit;
