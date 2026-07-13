begin;

create or replace function public.get_sent_message_copy_targets(
  p_message_id uuid
)
returns table (
  recipient_user_id uuid,
  recipient_device_id text
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select c.recipient_user_id, c.recipient_device_id
  from public.message_device_copies c
  join public.messages m on m.id = c.message_id
  where c.message_id = p_message_id
    and m.sender_id = auth.uid()
    and auth.uid() is not null;
$$;

revoke all on function public.get_sent_message_copy_targets(uuid) from public;
grant execute on function public.get_sent_message_copy_targets(uuid) to authenticated;

comment on function public.get_sent_message_copy_targets(uuid) is
  'Returns only the per-device copy targets for a message owned by the authenticated sender. Used to repair missing Sesame fan-out without exposing ciphertext.';

commit;
