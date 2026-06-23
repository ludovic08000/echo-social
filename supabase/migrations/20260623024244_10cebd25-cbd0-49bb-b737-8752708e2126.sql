-- Sesame §3.3 step 4 — server-side device-set reconciliation.
-- 1) Expose the canonical "deliverable device set" via a SECURITY DEFINER RPC.
-- 2) In send_message_with_device_copies, reject when copies do not cover every
--    deliverable device of every conversation participant (including the
--    sender's OTHER devices). The sender's current device is excluded per
--    Sesame ("a device does not keep a DeviceRecord for itself").

-- =====================================================================
-- 1. Helper RPC: get_conversation_deliverable_devices
-- =====================================================================
create or replace function public.get_conversation_deliverable_devices(
  p_conversation_id uuid,
  p_exclude_device_id text default null
) returns table(
  user_id uuid,
  device_id text,
  device_public_key text,
  is_self boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_conversation_id is null then
    raise exception 'conversation_required' using errcode = '23502';
  end if;
  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_uid
  ) then
    raise exception 'not_conversation_participant' using errcode = '42501';
  end if;

  return query
  select
    d.user_id,
    d.device_id,
    d.device_public_key,
    (d.user_id = v_uid) as is_self
  from public.conversation_participants cp
  join public.user_devices d on d.user_id = cp.user_id
  where cp.conversation_id = p_conversation_id
    and cp.user_id <> '00000000-0000-0000-0000-000000000001'::uuid  -- exclude Zeus
    and d.is_active = true
    and coalesce(d.approval_status, 'approved') = 'approved'
    and d.revoked_at is null
    and d.stale_at is null
    and d.device_public_key is not null
    and length(trim(d.device_public_key)) > 0
    and not public.is_invalid_e2ee_device(d.user_id, d.device_id)
    -- Sesame: do NOT include the sender's CURRENT device
    and (p_exclude_device_id is null or d.device_id <> p_exclude_device_id);
end
$$;

grant execute on function public.get_conversation_deliverable_devices(uuid, text) to authenticated;

-- =====================================================================
-- 2. send_message_with_device_copies — add coverage enforcement
-- =====================================================================
drop function if exists public.send_message_with_device_copies(uuid, uuid, text, text, jsonb, jsonb);
drop function if exists public.send_message_with_device_copies(uuid, text, text, jsonb, jsonb);

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
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_message_id uuid;
  v_copies_count int := coalesce(jsonb_array_length(coalesce(p_copies, '[]'::jsonb)), 0);
  v_body_kind text;
  v_body_json jsonb;
  v_body_is_encrypted boolean := false;
  v_is_zeus_conversation boolean := false;
  v_is_multi_device_parent boolean := false;
  v_bad_copy_count int := 0;
  v_sender_device_id text;
  v_missing_pairs text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_conversation_id is null then
    raise exception 'conversation_required' using errcode = '23502';
  end if;
  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_uid
  ) then
    raise exception 'sender_not_conversation_participant' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id
      and cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
  ) into v_is_zeus_conversation;

  if v_copies_count > 0 then
    v_body_kind := 'multi_device';
  else
    v_body_kind := coalesce(nullif(p_extra->>'body_kind', ''), 'legacy');
  end if;

  begin
    v_body_json := p_body::jsonb;
  exception when others then
    v_body_json := null;
  end;

  v_is_multi_device_parent :=
    v_body_json is not null
    and v_body_json->>'encryptionMode' = 'multi_device';

  -- Sesame: a multi-device parent with zero device copies is undeliverable.
  if not v_is_zeus_conversation and v_is_multi_device_parent and v_copies_count = 0 then
    raise exception 'E2EE_PLAINTEXT_MESSAGE_REJECTED_EMPTY_DEVICE_COPIES'
      using errcode = '23514',
            detail = 'Multi-device parent envelope rejected because no encrypted device copy was provided.';
  end if;

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

  -- ===== Per-row copy validation (shape + deliverability) =====
  if v_copies_count > 0 then
    with copy_rows as (
      select * from jsonb_to_recordset(p_copies) as c(
        recipient_user_id uuid,
        recipient_device_id text,
        sender_device_id text,
        encrypted_body text
      )
    )
    select count(*) into v_bad_copy_count
    from copy_rows c
    where c.recipient_user_id is null
       or c.recipient_device_id is null
       or length(trim(c.recipient_device_id)) < 8
       or c.sender_device_id is null
       or length(trim(c.sender_device_id)) < 8
       or c.encrypted_body is null
       or c.encrypted_body not like 'x3dh5.%'
       or not exists (
         select 1 from public.conversation_participants cp
         where cp.conversation_id = p_conversation_id and cp.user_id = c.recipient_user_id
       )
       or not exists (
         select 1 from public.user_devices d
         where d.user_id = c.recipient_user_id
           and d.device_id = c.recipient_device_id
           and d.is_active = true
           and coalesce(d.approval_status, 'approved') = 'approved'
           and d.revoked_at is null
           and d.stale_at is null
           and d.device_public_key is not null
           and length(trim(d.device_public_key)) > 0
           and not public.is_invalid_e2ee_device(d.user_id, d.device_id)
       );

    if v_bad_copy_count > 0 then
      raise exception 'E2EE_INVALID_DEVICE_COPY'
        using errcode = '23514',
              detail = format('Rejected %s invalid device copy row(s).', v_bad_copy_count);
    end if;

    -- ===== Sesame §3.3 step 4 — coverage check =====
    -- All copies share the same sender_device_id by construction; pick first.
    select (p_copies->0->>'sender_device_id') into v_sender_device_id;

    with deliverable as (
      select d.user_id, d.device_id
      from public.conversation_participants cp
      join public.user_devices d on d.user_id = cp.user_id
      where cp.conversation_id = p_conversation_id
        and cp.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
        and d.is_active = true
        and coalesce(d.approval_status, 'approved') = 'approved'
        and d.revoked_at is null
        and d.stale_at is null
        and d.device_public_key is not null
        and length(trim(d.device_public_key)) > 0
        and not public.is_invalid_e2ee_device(d.user_id, d.device_id)
        -- exclude the sender's CURRENT device (Sesame: no self-DeviceRecord)
        and not (d.user_id = v_uid and d.device_id = v_sender_device_id)
    ),
    provided as (
      select c.recipient_user_id as user_id, c.recipient_device_id as device_id
      from jsonb_to_recordset(p_copies) as c(
        recipient_user_id uuid,
        recipient_device_id text,
        sender_device_id text,
        encrypted_body text
      )
    ),
    missing as (
      select d.user_id, d.device_id
      from deliverable d
      left join provided p
        on p.user_id = d.user_id and p.device_id = d.device_id
      where p.device_id is null
    )
    select string_agg(format('%s/%s', user_id, device_id), ',')
      into v_missing_pairs
    from missing;

    if v_missing_pairs is not null then
      raise exception 'E2EE_MISSING_DEVICE_COPIES'
        using errcode = '23514',
              detail = v_missing_pairs,
              hint   = 'Refresh the deliverable device set via get_conversation_deliverable_devices and retry once.';
    end if;
  end if;

  -- ===== Insert parent + copies =====
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

  if v_copies_count > 0 then
    insert into public.message_device_copies (
      message_id, recipient_user_id, recipient_device_id,
      sender_user_id, sender_device_id, encrypted_body
    )
    select
      v_message_id, c.recipient_user_id, c.recipient_device_id,
      v_uid, c.sender_device_id, c.encrypted_body
    from jsonb_to_recordset(p_copies) as c(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    )
    on conflict (message_id, recipient_device_id) do nothing;
  end if;

  return v_message_id;
end
$$;

grant execute on function public.send_message_with_device_copies(uuid, uuid, text, text, jsonb, jsonb) to authenticated;
