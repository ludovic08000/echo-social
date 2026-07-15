begin;

-- Canonical signed list: exactly one active primary, a matching account root,
-- no stale device, and companions only when a signature under that root exists.
create or replace function public.get_signed_device_list(
  p_user_id uuid
)
returns table (
  device_id text,
  device_public_key text,
  is_primary boolean,
  primary_device_id text,
  primary_pub_b64 text,
  signature_b64 text,
  signed_at timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with active_devices as (
    select ud.device_id, ud.device_public_key, ud.is_primary
    from public.user_devices ud
    where ud.user_id = p_user_id
      and ud.is_active = true
      and coalesce(ud.approval_status, 'approved') = 'approved'
      and ud.revoked_at is null
      and ud.stale_at is null
      and ud.device_public_key is not null
      and length(trim(ud.device_public_key)) > 0
      and not public.is_invalid_e2ee_device(ud.user_id, ud.device_id)
  ),
  unique_primary as (
    select min(ad.device_id) as device_id
    from active_devices ad
    where ad.is_primary = true
    having count(*) = 1
  ),
  canonical_root as (
    select r.primary_device_id, r.identity_pub_b64
    from public.user_identity_roots r
    join unique_primary up on up.device_id = r.primary_device_id
    where r.user_id = p_user_id
      and r.identity_pub_b64 is not null
      and length(trim(r.identity_pub_b64)) > 0
  ),
  valid_signature_rows as (
    select distinct on (uds.device_id)
      uds.device_id,
      uds.primary_device_id,
      uds.primary_pub_b64,
      uds.signature_b64,
      uds.signed_at
    from public.user_device_signatures uds
    join canonical_root root
      on root.primary_device_id = uds.primary_device_id
     and root.identity_pub_b64 = uds.primary_pub_b64
    where uds.user_id = p_user_id
      and uds.revoked_at is null
      and uds.signature_b64 is not null
      and length(trim(uds.signature_b64)) > 0
    order by uds.device_id, uds.signed_at desc
  )
  select
    ad.device_id,
    ad.device_public_key,
    ad.is_primary,
    case when ad.is_primary then null else sig.primary_device_id end,
    root.identity_pub_b64,
    case when ad.is_primary then null else sig.signature_b64 end,
    case when ad.is_primary then null else sig.signed_at end
  from active_devices ad
  cross join canonical_root root
  left join valid_signature_rows sig on sig.device_id = ad.device_id
  where ad.is_primary = true or sig.signature_b64 is not null
  order by ad.is_primary desc, ad.device_id;
$$;

revoke all on function public.get_signed_device_list(uuid) from public;
grant execute on function public.get_signed_device_list(uuid) to authenticated;

-- New authoritative overload. The route cache on clients is only speculative;
-- this function is the delivery authority required by Sesame.
drop function if exists public.send_message_with_device_copies(uuid, uuid, text, text, jsonb, jsonb, text);

create function public.send_message_with_device_copies(
  p_message_id uuid,
  p_conversation_id uuid,
  p_body text,
  p_image_url text default null,
  p_extra jsonb default '{}'::jsonb,
  p_copies jsonb default '[]'::jsonb,
  p_sender_device_id text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_message_id uuid;
  v_existing_sender uuid;
  v_existing_conversation uuid;
  v_copies jsonb := coalesce(p_copies, '[]'::jsonb);
  v_copies_count integer := 0;
  v_distinct_copy_count integer := 0;
  v_expected_count integer := 0;
  v_body_kind text;
  v_body_json jsonb;
  v_body_is_encrypted boolean := false;
  v_is_zeus_conversation boolean := false;
  v_is_multi_device_parent boolean := false;
  v_bad_copy_count integer := 0;
  v_route_diff_count integer := 0;
  v_unroutable_participants integer := 0;
  v_expected_ids jsonb := '[]'::jsonb;
  v_supplied_ids jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_conversation_id is null then
    raise exception 'conversation_required' using errcode = '23502';
  end if;

  if not exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id
      and cp.user_id = v_uid
  ) then
    raise exception 'sender_not_conversation_participant' using errcode = '42501';
  end if;

  -- Idempotent retry: the same authenticated sender may safely retry the same
  -- message UUID after a timeout without advancing server state twice.
  if p_message_id is not null then
    select m.sender_id, m.conversation_id
      into v_existing_sender, v_existing_conversation
    from public.messages m
    where m.id = p_message_id;

    if found then
      if v_existing_sender = v_uid and v_existing_conversation = p_conversation_id then
        return p_message_id;
      end if;
      raise exception 'MESSAGE_ID_CONFLICT' using errcode = '23505';
    end if;
  end if;

  select exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id
      and cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
  ) into v_is_zeus_conversation;

  v_copies_count := jsonb_array_length(v_copies);

  begin
    v_body_json := p_body::jsonb;
  exception when others then
    v_body_json := null;
  end;

  v_is_multi_device_parent :=
    v_body_json is not null
    and v_body_json->>'encryptionMode' = 'multi_device';

  v_body_is_encrypted :=
    coalesce(p_body like 'x3dh5.%', false)
    or coalesce(p_body like 'x3dh4.%', false)
    or (
      v_body_json is not null
      and (
        v_body_json->>'encryptionMode' in ('multi_device', 'ratchet')
        or v_body_json ? 'fs_secure_pipeline'
        or (v_body_json ? 'ct' and (v_body_json ? 'hdr' or v_body_json ? 'kem'))
      )
    );

  if not v_is_zeus_conversation and not v_body_is_encrypted then
    raise exception 'E2EE_PLAINTEXT_MESSAGE_REJECTED'
      using errcode = '23514',
            detail = 'Peer conversations must store an encrypted E2EE envelope, never plaintext.';
  end if;

  if not v_is_zeus_conversation then
    if not v_is_multi_device_parent then
      raise exception 'E2EE_MULTI_DEVICE_PARENT_REQUIRED'
        using errcode = '23514';
    end if;

    if p_sender_device_id is null or length(trim(p_sender_device_id)) < 8 then
      raise exception 'E2EE_SENDER_DEVICE_REQUIRED'
        using errcode = '23514';
    end if;

    if not exists (
      select 1
      from public.get_signed_device_list(v_uid) own_device
      where own_device.device_id = p_sender_device_id
    ) then
      raise exception 'E2EE_SENDER_DEVICE_NOT_TRUSTED'
        using errcode = '23514';
    end if;

    -- Every non-sender participant must expose at least one canonical signed
    -- device. The sender may legitimately have no target after excluding the
    -- current physical device.
    with participants as (
      select distinct cp.user_id
      from public.conversation_participants cp
      where cp.conversation_id = p_conversation_id
        and cp.user_id <> v_uid
    ), participant_routes as (
      select p.user_id, count(dl.device_id) as device_count
      from participants p
      left join lateral public.get_signed_device_list(p.user_id) dl on true
      group by p.user_id
    )
    select count(*) into v_unroutable_participants
    from participant_routes pr
    where pr.device_count = 0;

    if v_unroutable_participants > 0 then
      raise exception 'E2EE_DEVICE_LIST_UNAVAILABLE'
        using errcode = '23514',
              detail = format('%s participant(s) have no canonical signed device.', v_unroutable_participants);
    end if;

    with expected as (
      select distinct cp.user_id as recipient_user_id, dl.device_id as recipient_device_id
      from public.conversation_participants cp
      cross join lateral public.get_signed_device_list(cp.user_id) dl
      where cp.conversation_id = p_conversation_id
        and not (cp.user_id = v_uid and dl.device_id = p_sender_device_id)
    ), supplied as (
      select *
      from jsonb_to_recordset(v_copies) as c(
        recipient_user_id uuid,
        recipient_device_id text,
        sender_device_id text,
        encrypted_body text
      )
    )
    select
      (select count(*) from expected),
      (select count(*) from supplied),
      (select count(*) from (select distinct recipient_user_id, recipient_device_id from supplied) d),
      (select count(*) from (
        (select recipient_user_id, recipient_device_id from expected
         except
         select recipient_user_id, recipient_device_id from supplied)
        union all
        (select recipient_user_id, recipient_device_id from supplied
         except
         select recipient_user_id, recipient_device_id from expected)
      ) diff),
      coalesce((select jsonb_agg(recipient_user_id::text || ':' || recipient_device_id order by recipient_user_id::text, recipient_device_id) from expected), '[]'::jsonb),
      coalesce((select jsonb_agg(recipient_user_id::text || ':' || recipient_device_id order by recipient_user_id::text, recipient_device_id) from supplied), '[]'::jsonb)
    into
      v_expected_count,
      v_copies_count,
      v_distinct_copy_count,
      v_route_diff_count,
      v_expected_ids,
      v_supplied_ids;

    with supplied as (
      select *
      from jsonb_to_recordset(v_copies) as c(
        recipient_user_id uuid,
        recipient_device_id text,
        sender_device_id text,
        encrypted_body text
      )
    )
    select count(*) into v_bad_copy_count
    from supplied c
    where c.recipient_user_id is null
       or c.recipient_device_id is null
       or length(trim(c.recipient_device_id)) < 8
       or c.sender_device_id is null
       or c.sender_device_id <> p_sender_device_id
       or c.encrypted_body is null
       or c.encrypted_body not like 'x3dh5.%';

    if v_bad_copy_count > 0 then
      raise exception 'E2EE_INVALID_DEVICE_COPY'
        using errcode = '23514',
              detail = format('Rejected %s malformed or wrongly-signed device copy row(s).', v_bad_copy_count);
    end if;

    if v_expected_count = 0 then
      raise exception 'E2EE_NO_SECURE_TARGET'
        using errcode = '23514';
    end if;

    if v_copies_count <> v_distinct_copy_count
       or v_copies_count <> v_expected_count
       or v_route_diff_count <> 0 then
      raise exception 'E2EE_DEVICE_LIST_STALE'
        using errcode = 'P0001',
              detail = jsonb_build_object(
                'expected', v_expected_ids,
                'supplied', v_supplied_ids,
                'expected_count', v_expected_count,
                'supplied_count', v_copies_count
              )::text;
    end if;

    v_body_kind := 'multi_device';
  else
    v_body_kind := coalesce(nullif(p_extra->>'body_kind', ''), 'legacy');
  end if;

  insert into public.messages (
    id, conversation_id, sender_id, body, image_url, body_kind,
    view_once, expires_at, document_url, document_name, document_mime,
    document_size_bytes, archive_body
  ) values (
    coalesce(p_message_id, gen_random_uuid()),
    p_conversation_id,
    v_uid,
    p_body,
    nullif(p_image_url, ''),
    v_body_kind,
    coalesce((p_extra->>'view_once')::boolean, false),
    nullif(p_extra->>'expires_at', '')::timestamptz,
    nullif(p_extra->>'document_url', ''),
    nullif(p_extra->>'document_name', ''),
    nullif(p_extra->>'document_mime', ''),
    nullif(p_extra->>'document_size_bytes', '')::int,
    nullif(p_extra->>'archive_body', '')
  )
  returning id into v_message_id;

  if not v_is_zeus_conversation then
    insert into public.message_device_copies (
      message_id, recipient_user_id, recipient_device_id,
      sender_user_id, sender_device_id, encrypted_body
    )
    select
      v_message_id, c.recipient_user_id, c.recipient_device_id,
      v_uid, c.sender_device_id, c.encrypted_body
    from jsonb_to_recordset(v_copies) as c(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    );
  end if;

  return v_message_id;
end
$$;

revoke all on function public.send_message_with_device_copies(uuid, uuid, text, text, jsonb, jsonb, text) from public;
grant execute on function public.send_message_with_device_copies(uuid, uuid, text, text, jsonb, jsonb, text) to authenticated;

-- Compatibility wrapper for already-open clients. It derives the sender device
-- only when every supplied copy agrees, then delegates to the authoritative RPC.
create or replace function public.send_message_with_device_copies(
  p_message_id uuid,
  p_conversation_id uuid,
  p_body text,
  p_image_url text default null,
  p_extra jsonb default '{}'::jsonb,
  p_copies jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_sender_device_id text;
  v_sender_device_count integer;
begin
  select min(c.sender_device_id), count(distinct c.sender_device_id)
    into v_sender_device_id, v_sender_device_count
  from jsonb_to_recordset(coalesce(p_copies, '[]'::jsonb)) as c(sender_device_id text);

  if v_sender_device_count > 1 then
    raise exception 'E2EE_MULTIPLE_SENDER_DEVICES' using errcode = '23514';
  end if;

  return public.send_message_with_device_copies(
    p_message_id,
    p_conversation_id,
    p_body,
    p_image_url,
    p_extra,
    p_copies,
    v_sender_device_id
  );
end
$$;

revoke all on function public.send_message_with_device_copies(uuid, uuid, text, text, jsonb, jsonb) from public;
grant execute on function public.send_message_with_device_copies(uuid, uuid, text, text, jsonb, jsonb) to authenticated;

commit;
