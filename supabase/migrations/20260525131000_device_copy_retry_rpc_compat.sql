-- Compatibility layer for the existing web client deviceCopyRetryProcessor.ts.
-- The client already calls:
--   list_pending_device_copy_retries(limit)
--   complete_device_copy_retry(request_id, encrypted_body, sender_device_id)
--   mark_device_copy_retry_failed(request_id, error)
-- This migration exposes those names on top of device_copy_retry_requests.

create or replace function public.list_pending_device_copy_retries(
  p_limit integer default 20
)
returns table (
  request_id uuid,
  message_id uuid,
  conversation_id uuid,
  message_body text,
  requester_user_id uuid,
  requester_device_id text,
  requester_device_public_key text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  return query
  select
    r.id as request_id,
    r.message_id,
    m.conversation_id,
    m.body as message_body,
    r.requester_user_id,
    r.requester_device_id,
    ud.device_public_key as requester_device_public_key,
    r.attempts as attempt_count
  from public.device_copy_retry_requests r
  join public.messages m on m.id = r.message_id
  join public.user_devices ud
    on ud.user_id = r.requester_user_id
   and ud.device_id = r.requester_device_id
   and ud.is_active = true
  where r.sender_user_id = auth.uid()
    and r.status = 'pending'
    and ud.device_public_key is not null
  order by r.created_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 200));
end;
$$;

grant execute on function public.list_pending_device_copy_retries(integer) to authenticated;

create or replace function public.complete_device_copy_retry(
  p_request_id uuid,
  p_encrypted_body text,
  p_sender_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender uuid := auth.uid();
  v_req public.device_copy_retry_requests%rowtype;
begin
  if v_sender is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  select * into v_req
  from public.device_copy_retry_requests
  where id = p_request_id
    and sender_user_id = v_sender
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;

  insert into public.message_device_copies (
    message_id,
    recipient_user_id,
    recipient_device_id,
    sender_user_id,
    sender_device_id,
    encrypted_body
  ) values (
    v_req.message_id,
    v_req.requester_user_id,
    v_req.requester_device_id,
    v_sender,
    p_sender_device_id,
    p_encrypted_body
  )
  on conflict (message_id, recipient_device_id)
  do update set
    encrypted_body = excluded.encrypted_body,
    sender_user_id = excluded.sender_user_id,
    sender_device_id = excluded.sender_device_id;

  update public.device_copy_retry_requests
  set status = 'done',
      updated_at = now(),
      last_error = null
  where id = p_request_id;

  return jsonb_build_object('ok', true, 'code', 'DEVICE_COPY_RETRY_COMPLETED');
end;
$$;

grant execute on function public.complete_device_copy_retry(uuid, text, text) to authenticated;

create or replace function public.mark_device_copy_retry_failed(
  p_request_id uuid,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  update public.device_copy_retry_requests
  set status = 'failed',
      attempts = attempts + 1,
      last_error = left(coalesce(p_error, 'unknown'), 500),
      updated_at = now()
  where id = p_request_id
    and sender_user_id = auth.uid();

  if not found then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;

  return jsonb_build_object('ok', true, 'code', 'DEVICE_COPY_RETRY_FAILED');
end;
$$;

grant execute on function public.mark_device_copy_retry_failed(uuid, text) to authenticated;
