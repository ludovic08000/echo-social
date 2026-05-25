-- Stabilize iOS -> Windows multi-device E2EE recovery.
--
-- Problems addressed:
-- 1) Old devices can remain active while their device_signed_prekeys were
--    signed by a previous account signing key. Other clients then keep trying
--    invalid X3DH bundles and spam "device SPK signature INVALID".
-- 2) A restored/new device can request a fresh per-device copy of a message,
--    but the sender needs a durable queue to process those requests.

-- Queue table for receiver -> sender retry requests.
create table if not exists public.device_copy_retry_requests (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null,
  sender_user_id uuid not null,
  requester_user_id uuid not null,
  requester_device_id text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, sender_user_id, requester_user_id, requester_device_id)
);

alter table public.device_copy_retry_requests enable row level security;

drop policy if exists "retry_request_insert_self" on public.device_copy_retry_requests;
create policy "retry_request_insert_self"
on public.device_copy_retry_requests
for insert
to authenticated
with check (requester_user_id = auth.uid());

drop policy if exists "retry_request_read_sender_or_requester" on public.device_copy_retry_requests;
create policy "retry_request_read_sender_or_requester"
on public.device_copy_retry_requests
for select
to authenticated
using (sender_user_id = auth.uid() or requester_user_id = auth.uid());

drop policy if exists "retry_request_update_sender" on public.device_copy_retry_requests;
create policy "retry_request_update_sender"
on public.device_copy_retry_requests
for update
to authenticated
using (sender_user_id = auth.uid())
with check (sender_user_id = auth.uid());

create index if not exists idx_device_copy_retry_sender_pending
on public.device_copy_retry_requests (sender_user_id, status, created_at desc);

create index if not exists idx_device_copy_retry_message
on public.device_copy_retry_requests (message_id);

-- Receiver calls this when it cannot decrypt an existing copy. It verifies the
-- parent message sender, then creates/refreshes a pending request.
create or replace function public.request_device_copy_retry(
  p_message_id uuid,
  p_sender_user_id uuid,
  p_requester_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester uuid := auth.uid();
  v_message_sender uuid;
  v_is_participant boolean;
begin
  if v_requester is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  select m.sender_id into v_message_sender
  from public.messages m
  where m.id = p_message_id;

  if v_message_sender is null or v_message_sender <> p_sender_user_id then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_SENDER_MISMATCH');
  end if;

  select exists (
    select 1
    from public.messages m
    join public.conversation_participants cp on cp.conversation_id = m.conversation_id
    where m.id = p_message_id
      and cp.user_id = v_requester
  ) into v_is_participant;

  if not v_is_participant then
    return jsonb_build_object('ok', false, 'code', 'NOT_CONVERSATION_PARTICIPANT');
  end if;

  insert into public.device_copy_retry_requests (
    message_id,
    sender_user_id,
    requester_user_id,
    requester_device_id,
    status,
    attempts,
    updated_at
  ) values (
    p_message_id,
    p_sender_user_id,
    v_requester,
    p_requester_device_id,
    'pending',
    0,
    now()
  )
  on conflict (message_id, sender_user_id, requester_user_id, requester_device_id)
  do update set
    status = 'pending',
    updated_at = now(),
    last_error = null;

  return jsonb_build_object('ok', true, 'code', 'RETRY_REQUEST_QUEUED');
end;
$$;

grant execute on function public.request_device_copy_retry(uuid, uuid, text) to authenticated;

-- Sender fetches pending retry requests for messages they originally sent.
create or replace function public.get_pending_device_copy_retry_requests(
  p_limit integer default 50
)
returns table (
  id uuid,
  message_id uuid,
  conversation_id uuid,
  requester_user_id uuid,
  requester_device_id text,
  created_at timestamptz
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
  select r.id, r.message_id, m.conversation_id, r.requester_user_id, r.requester_device_id, r.created_at
  from public.device_copy_retry_requests r
  join public.messages m on m.id = r.message_id
  where r.sender_user_id = auth.uid()
    and r.status = 'pending'
  order by r.created_at asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

grant execute on function public.get_pending_device_copy_retry_requests(integer) to authenticated;

create or replace function public.mark_device_copy_retry_request(
  p_request_id uuid,
  p_status text,
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

  if p_status not in ('processing', 'done', 'failed', 'pending') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATUS');
  end if;

  update public.device_copy_retry_requests
  set status = p_status,
      attempts = case when p_status in ('processing', 'failed') then attempts + 1 else attempts end,
      last_error = p_error,
      updated_at = now()
  where id = p_request_id
    and sender_user_id = auth.uid();

  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_NOT_OWNER');
  end if;

  return jsonb_build_object('ok', true, 'code', 'UPDATED');
end;
$$;

grant execute on function public.mark_device_copy_retry_request(uuid, text, text) to authenticated;

-- Sender-side helper: fetch the active public key of the exact requester device.
create or replace function public.get_active_device_public_key(
  p_user_id uuid,
  p_device_id text
)
returns table (
  user_id uuid,
  device_id text,
  device_public_key text
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
  select ud.user_id, ud.device_id, ud.device_public_key
  from public.user_devices ud
  where ud.user_id = p_user_id
    and ud.device_id = p_device_id
    and ud.is_active = true
    and ud.device_public_key is not null
  limit 1;
end;
$$;

grant execute on function public.get_active_device_public_key(uuid, text) to authenticated;

-- Current device cleanup. This does not try to verify Ed25519 signatures in SQL;
-- the client does that. It removes obviously stale active devices and their SPKs,
-- so senders stop targeting abandoned device ids.
create or replace function public.cleanup_current_user_stale_devices(
  p_current_device_id text,
  p_stale_after interval default interval '30 days'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_deactivated integer := 0;
  v_spks_deactivated integer := 0;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  update public.user_devices
  set is_active = false,
      updated_at = coalesce(updated_at, now())
  where user_id = v_user
    and device_id <> p_current_device_id
    and is_active = true
    and coalesce(last_seen_at, created_at, now() - interval '100 years') < now() - p_stale_after;

  get diagnostics v_deactivated = row_count;

  update public.device_signed_prekeys dsp
  set is_active = false,
      is_last_resort = false
  where dsp.user_id = v_user
    and dsp.device_id <> p_current_device_id
    and exists (
      select 1
      from public.user_devices ud
      where ud.user_id = dsp.user_id
        and ud.device_id = dsp.device_id
        and ud.is_active = false
    );

  get diagnostics v_spks_deactivated = row_count;

  return jsonb_build_object(
    'ok', true,
    'code', 'STALE_DEVICES_CLEANED',
    'devices_deactivated', v_deactivated,
    'spks_deactivated', v_spks_deactivated
  );
end;
$$;

grant execute on function public.cleanup_current_user_stale_devices(text, interval) to authenticated;
