begin;

create or replace function public.get_device_copies_for_messages(
  p_message_ids uuid[],
  p_device_id text
)
returns table (
  message_id uuid,
  encrypted_body text,
  sender_user_id uuid,
  sender_device_id text,
  recipient_device_id text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    copy.message_id,
    copy.encrypted_body,
    copy.sender_user_id,
    copy.sender_device_id,
    copy.recipient_device_id,
    copy.created_at
  from public.message_device_copies copy
  join public.messages message
    on message.id = copy.message_id
   and message.sender_id = copy.sender_user_id
  join public.conversation_participants participant
    on participant.conversation_id = message.conversation_id
   and participant.user_id = auth.uid()
  where auth.uid() is not null
    and coalesce(cardinality(p_message_ids), 0) between 1 and 200
    and nullif(trim(coalesce(p_device_id, '')), '') is not null
    and copy.message_id = any(p_message_ids)
    and copy.recipient_user_id = auth.uid()
    and copy.recipient_device_id = trim(p_device_id)
    and exists (
      select 1
      from public.user_devices device
      where device.user_id = auth.uid()
        and device.device_id = trim(p_device_id)
        and device.is_active = true
        and coalesce(device.approval_status, 'approved') = 'approved'
        and device.revoked_at is null
        and coalesce(device.routing_status, 'repairing') <> 'unavailable'
        and nullif(trim(device.device_public_key), '') is not null
        and nullif(trim(device.device_signing_key), '') is not null
        and nullif(trim(device.device_authorization_signature), '') is not null
    )
  order by copy.created_at, copy.message_id;
$$;

revoke all on function public.get_device_copies_for_messages(uuid[],text) from public, anon;
grant execute on function public.get_device_copies_for_messages(uuid[],text) to authenticated;

notify pgrst, 'reload schema';

commit;
