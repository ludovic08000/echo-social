-- Aegis clean transport transaction.
--
-- One stable message UUID identifies one immutable encrypted request. Calls for
-- the same UUID are serialized inside PostgreSQL, so a retry can never race the
-- original call and then rewind a Ratchet that has already committed.

begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.messages
  add column if not exists aegis_request_digest text;

comment on column public.messages.aegis_request_digest is
  'SHA-256 of the complete immutable Aegis send request used for exact idempotency.';

drop function if exists public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
);

create function public.aegis_send_message(
  p_message_id uuid,
  p_conversation_id uuid,
  p_body text,
  p_image_url text,
  p_extra jsonb,
  p_copies jsonb,
  p_sender_device_id text,
  p_route_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_sender uuid;
  v_existing_digest text;
  v_current_route_version text;
  v_copies jsonb := coalesce(p_copies, '[]'::jsonb);
  v_normalized_copies jsonb := '[]'::jsonb;
  v_request_digest text;
  v_copies_count integer := 0;
  v_distinct_copy_count integer := 0;
  v_bad_copy_count integer := 0;
  v_missing_count integer := 0;
  v_unexpected_count integer := 0;
  v_unroutable_participants integer := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_message_id is null or p_conversation_id is null then
    raise exception 'AEGIS_STABLE_UUID_REQUIRED' using errcode = '23502';
  end if;
  if jsonb_typeof(v_copies) <> 'array' then
    raise exception 'E2EE_INVALID_DEVICE_COPY' using errcode = '23514';
  end if;

  -- Normalize only fields that are accepted and written by this RPC. JSONB has
  -- deterministic object-key ordering; the explicit row order makes the array
  -- independent of client ordering.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'recipient_user_id', copy.recipient_user_id,
        'recipient_device_id', copy.recipient_device_id,
        'sender_device_id', copy.sender_device_id,
        'encrypted_body', copy.encrypted_body
      )
      order by
        copy.recipient_user_id,
        copy.recipient_device_id,
        copy.sender_device_id,
        copy.encrypted_body
    ),
    '[]'::jsonb
  )
  into v_normalized_copies
  from jsonb_to_recordset(v_copies) as copy(
    recipient_user_id uuid,
    recipient_device_id text,
    sender_device_id text,
    encrypted_body text
  );

  v_request_digest := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'message_id', p_message_id,
          'conversation_id', p_conversation_id,
          'sender_user_id', v_uid,
          'body', p_body,
          'image_url', nullif(p_image_url, ''),
          'extra', coalesce(p_extra, '{}'::jsonb),
          'sender_device_id', trim(coalesce(p_sender_device_id, '')),
          'route_version', p_route_version,
          'copies', v_normalized_copies
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- Serialize every original call, timeout confirmation and later outbox retry
  -- for this UUID. A confirmation cannot overtake a still-running insert.
  perform pg_advisory_xact_lock(hashtextextended(p_message_id::text, 0));

  -- Exact confirmation precedes current membership, device and route checks.
  -- A message already committed remains confirmable if a user later leaves the
  -- conversation or a device is subsequently revoked.
  select message.sender_id, message.aegis_request_digest
    into v_existing_sender, v_existing_digest
  from public.messages message
  where message.id = p_message_id;

  if found then
    if v_existing_sender = v_uid
       and v_existing_digest is not null
       and v_existing_digest = v_request_digest then
      return jsonb_build_object(
        'state', 'committed',
        'message_id', p_message_id,
        'request_digest', v_request_digest,
        'existing', true
      );
    end if;
    raise exception 'MESSAGE_ID_CONFLICT' using errcode = '23505';
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

  if not public.is_supported_aegis_message(p_body, 'multi_device') then
    raise exception 'AEGIS_WIRE_FORMAT_REJECTED' using errcode = '23514';
  end if;
  if length(trim(coalesce(p_sender_device_id, ''))) < 8 then
    raise exception 'E2EE_SENDER_DEVICE_REQUIRED' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.get_sesame_device_list(v_uid) own_device
    where own_device.device_id = trim(p_sender_device_id)
      and own_device.is_routable = true
  ) then
    raise exception 'E2EE_SENDER_DEVICE_NOT_TRUSTED'
      using errcode = '23514';
  end if;

  -- Lock every participant route counter until the parent and all copies commit.
  insert into public.aegis_user_route_versions (user_id, route_version)
  select participant.user_id, 1
  from public.conversation_participants participant
  where participant.conversation_id = p_conversation_id
  on conflict (user_id) do nothing;

  perform route.user_id
  from public.aegis_user_route_versions route
  join public.conversation_participants participant
    on participant.user_id = route.user_id
  where participant.conversation_id = p_conversation_id
  order by route.user_id
  for share of route;

  v_current_route_version :=
    public.get_aegis_conversation_route_version(p_conversation_id);
  if p_route_version is null
     or p_route_version is distinct from v_current_route_version then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Prepared route %s does not match current route %s.',
              coalesce(p_route_version, 'NULL'),
              v_current_route_version
            );
  end if;

  with supplied as (
    select *
    from jsonb_to_recordset(v_normalized_copies) as copy(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    )
  )
  select
    count(*),
    count(distinct (recipient_user_id, recipient_device_id))
  into v_copies_count, v_distinct_copy_count
  from supplied;

  if v_copies_count = 0 then
    raise exception 'E2EE_NO_SECURE_TARGET' using errcode = '23514';
  end if;
  if v_copies_count <> v_distinct_copy_count then
    raise exception 'E2EE_DUPLICATE_DEVICE_COPY' using errcode = '23514';
  end if;

  with supplied as (
    select *
    from jsonb_to_recordset(v_normalized_copies) as copy(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    )
  )
  select count(*)
  into v_bad_copy_count
  from supplied copy
  where copy.recipient_user_id is null
     or length(trim(coalesce(copy.recipient_device_id, ''))) < 8
     or copy.sender_device_id is distinct from trim(p_sender_device_id)
     or not (
       copy.encrypted_body like 'aegis1.ratchet.%'
       or copy.encrypted_body like 'aegis1.init.v1.%'
     );

  if v_bad_copy_count > 0 then
    raise exception 'E2EE_INVALID_DEVICE_COPY' using errcode = '23514';
  end if;

  select count(*)
  into v_unroutable_participants
  from (
    select distinct participant.user_id
    from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id <> v_uid
  ) peer
  where not exists (
    select 1
    from public.get_sesame_device_list(peer.user_id) device
    where device.is_routable = true
  );

  if v_unroutable_participants > 0 then
    raise exception 'E2EE_PARTICIPANT_ROUTE_UNAVAILABLE'
      using errcode = '23514';
  end if;

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral public.get_sesame_device_list(participant.user_id) device
    where participant.conversation_id = p_conversation_id
      and device.is_routable = true
      and not (
        participant.user_id = v_uid
        and device.device_id = trim(p_sender_device_id)
      )
  ),
  supplied as (
    select *
    from jsonb_to_recordset(v_normalized_copies) as copy(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    )
  )
  select
    count(*) filter (where supplied.recipient_device_id is null),
    (
      select count(*)
      from supplied copy
      where not exists (
        select 1
        from expected route
        where route.recipient_user_id = copy.recipient_user_id
          and route.recipient_device_id = copy.recipient_device_id
      )
    )
  into v_missing_count, v_unexpected_count
  from expected
  left join supplied
    on supplied.recipient_user_id = expected.recipient_user_id
   and supplied.recipient_device_id = expected.recipient_device_id;

  if v_missing_count > 0 or v_unexpected_count > 0 then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Stable route mismatch: %s missing, %s unexpected.',
              v_missing_count,
              v_unexpected_count
            );
  end if;

  insert into public.messages (
    id, conversation_id, sender_id, body, image_url, body_kind,
    view_once, expires_at, document_url, document_name, document_mime,
    document_size_bytes, archive_body, aegis_route_version,
    aegis_request_digest
  )
  values (
    p_message_id,
    p_conversation_id,
    v_uid,
    p_body,
    nullif(p_image_url, ''),
    'multi_device',
    coalesce((coalesce(p_extra, '{}'::jsonb)->>'view_once')::boolean, false),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'expires_at', '')::timestamptz,
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_url', ''),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_name', ''),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_mime', ''),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_size_bytes', '')::integer,
    nullif(coalesce(p_extra, '{}'::jsonb)->>'archive_body', ''),
    p_route_version,
    v_request_digest
  );

  insert into public.message_device_copies (
    message_id, recipient_user_id, recipient_device_id,
    sender_user_id, sender_device_id, encrypted_body
  )
  select
    p_message_id,
    copy.recipient_user_id,
    copy.recipient_device_id,
    v_uid,
    copy.sender_device_id,
    copy.encrypted_body
  from jsonb_to_recordset(v_normalized_copies) as copy(
    recipient_user_id uuid,
    recipient_device_id text,
    sender_device_id text,
    encrypted_body text
  );

  return jsonb_build_object(
    'state', 'committed',
    'message_id', p_message_id,
    'request_digest', v_request_digest,
    'existing', false
  );
end;
$$;

revoke all on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) from public, anon;
grant execute on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) to authenticated;

comment on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) is 'Serializes one immutable Aegis request per message UUID and returns an authoritative commit receipt.';

notify pgrst, 'reload schema';

commit;
