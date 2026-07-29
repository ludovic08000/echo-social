-- Reliable server-readable message transport.
--
-- New peer messages no longer depend on DeviceID registration, signed prekeys,
-- route versions or per-device fan-out. Existing `multi_device` Aegis rows stay
-- valid and readable by legacy clients. LiveKit call E2EE is not affected.

begin;

-- Keep the historical function name because the existing table constraint
-- calls it, but add an explicit server-readable wire mode.
create or replace function public.is_supported_aegis_message(
  p_body text,
  p_body_kind text
) returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_body jsonb;
begin
  if p_body_kind = 'system' then
    return true;
  end if;

  if p_body_kind = 'server' then
    return p_body is not null
      and octet_length(p_body) <= 262144;
  end if;

  if p_body_kind <> 'multi_device' then
    return false;
  end if;

  begin
    v_body := p_body::jsonb;
  exception when others then
    return false;
  end;

  return coalesce(
    v_body->>'protocol' = 'forsure-aegis-message'
    and v_body->>'version' = '1'
    and v_body->>'encryptionMode' = 'multi_device'
    and v_body->>'algorithm' = 'AES-256-GCM'
    and v_body->>'keyTransport' = 'device_ratchet'
    and length(v_body->>'messageId') >= 36
    and length(v_body->>'conversationId') >= 36
    and length(v_body->>'senderId') >= 36
    and length(v_body->>'iv') >= 16
    and length(v_body->>'ciphertext') >= 20
    and length(v_body->>'digest') >= 40,
    false
  );
end;
$$;

-- Preserve strict validation for legacy Aegis rows while allowing the new
-- server mode. This trigger also protects direct REST inserts, so the same
-- sender, membership, size and rate rules apply outside the RPC.
create or replace function public.enforce_aegis_message_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body jsonb;
  v_uid uuid := auth.uid();
begin
  if new.body_kind = 'system' then
    if not exists (
      select 1
      from public.conversation_participants sender_cp
      where sender_cp.conversation_id = new.conversation_id
        and sender_cp.user_id = new.sender_id
    ) or not exists (
      select 1
      from public.conversation_participants zeus_cp
      where zeus_cp.conversation_id = new.conversation_id
        and zeus_cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
    ) or exists (
      select 1
      from public.conversation_participants other_cp
      where other_cp.conversation_id = new.conversation_id
        and other_cp.user_id not in (
          new.sender_id,
          '00000000-0000-0000-0000-000000000001'::uuid
        )
    ) then
      raise exception 'E2EE_SYSTEM_MESSAGE_SCOPE_REJECTED'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.body_kind = 'server' then
    if v_uid is null then
      raise exception 'not_authenticated' using errcode = '42501';
    end if;

    if new.sender_id <> v_uid then
      raise exception 'SERVER_MESSAGE_SENDER_MISMATCH'
        using errcode = '42501';
    end if;

    if not exists (
      select 1
      from public.conversation_participants sender_cp
      where sender_cp.conversation_id = new.conversation_id
        and sender_cp.user_id = v_uid
    ) then
      raise exception 'SERVER_MESSAGE_SENDER_NOT_PARTICIPANT'
        using errcode = '42501';
    end if;

    if coalesce(octet_length(new.body), 0) = 0
       and nullif(trim(coalesce(new.image_url, '')), '') is null
       and nullif(trim(coalesce(new.document_url, '')), '') is null then
      raise exception 'SERVER_MESSAGE_EMPTY'
        using errcode = '22023';
    end if;

    if coalesce(octet_length(new.body), 0) > 262144 then
      raise exception 'SERVER_MESSAGE_TOO_LARGE'
        using errcode = '22001';
    end if;

    if length(coalesce(new.image_url, '')) > 4096
       or length(coalesce(new.document_url, '')) > 4096
       or length(coalesce(new.document_name, '')) > 512
       or length(coalesce(new.document_mime, '')) > 255 then
      raise exception 'SERVER_MESSAGE_METADATA_TOO_LARGE'
        using errcode = '22001';
    end if;

    if not public.check_rate_limit(
      'server-message:' || v_uid::text,
      60,
      60
    ) then
      raise exception 'MESSAGE_RATE_LIMITED'
        using errcode = 'P0001';
    end if;

    new.status := 'delivered';
    new.aegis_route_version := null;
    return new;
  end if;

  if not public.is_supported_aegis_message(new.body, new.body_kind) then
    raise exception 'AEGIS_WIRE_FORMAT_REJECTED' using errcode = '23514';
  end if;

  v_body := new.body::jsonb;
  begin
    if (v_body->>'messageId')::uuid <> new.id
       or (v_body->>'conversationId')::uuid <> new.conversation_id
       or (v_body->>'senderId')::uuid <> new.sender_id then
      raise exception 'AEGIS_STABLE_UUID_BINDING_REJECTED' using errcode = '23514';
    end if;
  exception
    when invalid_text_representation then
      raise exception 'AEGIS_INVALID_UUID' using errcode = '23514';
  end;

  return new;
end;
$$;

-- Stable UUID + exact-body idempotency makes a retry safe after a lost network
-- response. No client-provided sender id, device id or route is accepted.
drop function if exists public.send_message_server(
  uuid, uuid, text, text, jsonb
);

create function public.send_message_server(
  p_message_id uuid,
  p_conversation_id uuid,
  p_body text,
  p_image_url text default null,
  p_extra jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_extra jsonb := coalesce(p_extra, '{}'::jsonb);
  v_existing public.messages%rowtype;
  v_body text := coalesce(p_body, '');
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_message_id is null or p_conversation_id is null then
    raise exception 'SERVER_MESSAGE_STABLE_UUID_REQUIRED'
      using errcode = '23502';
  end if;

  if not exists (
    select 1
    from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id = v_uid
  ) then
    raise exception 'sender_not_conversation_participant'
      using errcode = '42501';
  end if;

  if octet_length(v_body) > 262144 then
    raise exception 'SERVER_MESSAGE_TOO_LARGE' using errcode = '22001';
  end if;

  if octet_length(v_body) = 0
     and nullif(trim(coalesce(p_image_url, '')), '') is null
     and nullif(trim(coalesce(v_extra->>'document_url', '')), '') is null then
    raise exception 'SERVER_MESSAGE_EMPTY' using errcode = '22023';
  end if;

  if length(coalesce(p_image_url, '')) > 4096
     or length(coalesce(v_extra->>'document_url', '')) > 4096
     or length(coalesce(v_extra->>'document_name', '')) > 512
     or length(coalesce(v_extra->>'document_mime', '')) > 255 then
    raise exception 'SERVER_MESSAGE_METADATA_TOO_LARGE'
      using errcode = '22001';
  end if;

  -- Resolve an ambiguous retry before the rate-limited insert path. A caller
  -- that lost the first HTTP response must always recover the same committed id.
  select * into v_existing
  from public.messages message
  where message.id = p_message_id;

  if found then
    if v_existing.sender_id = v_uid
       and v_existing.conversation_id = p_conversation_id
       and v_existing.body = v_body
       and coalesce(v_existing.image_url, '') = coalesce(nullif(p_image_url, ''), '')
       and v_existing.body_kind = 'server' then
      return p_message_id;
    end if;
    raise exception 'MESSAGE_ID_CONFLICT' using errcode = '23505';
  end if;

  insert into public.messages (
    id,
    conversation_id,
    sender_id,
    body,
    image_url,
    body_kind,
    status,
    view_once,
    expires_at,
    document_url,
    document_name,
    document_mime,
    document_size_bytes,
    archive_body,
    aegis_route_version
  ) values (
    p_message_id,
    p_conversation_id,
    v_uid,
    v_body,
    nullif(p_image_url, ''),
    'server',
    'delivered',
    coalesce((v_extra->>'view_once')::boolean, false),
    nullif(v_extra->>'expires_at', '')::timestamptz,
    nullif(v_extra->>'document_url', ''),
    nullif(v_extra->>'document_name', ''),
    nullif(v_extra->>'document_mime', ''),
    nullif(v_extra->>'document_size_bytes', '')::integer,
    nullif(v_extra->>'archive_body', ''),
    null
  );

  update public.conversations
  set updated_at = now()
  where id = p_conversation_id;

  return p_message_id;
end;
$$;

revoke all on function public.send_message_server(
  uuid, uuid, text, text, jsonb
) from public, anon;
grant execute on function public.send_message_server(
  uuid, uuid, text, text, jsonb
) to authenticated;

comment on function public.send_message_server(
  uuid, uuid, text, text, jsonb
) is 'Idempotent authenticated message send without device-route or fan-out dependencies.';

notify pgrst, 'reload schema';
commit;
