-- Aegis v1 resilient authenticated routes.
--
-- Development cutover policy:
--   * old messages may be lost;
--   * every supplied copy must still target a canonical signed device;
--   * one stale device must not deny service to every healthy device;
--   * every non-sender participant must receive at least one encrypted copy.

begin;

-- A known approved device that authenticates again is no longer stale. The
-- registration RPC advances last_seen_at but older versions never cleared the
-- stale marker, leaving a successfully logged-in device permanently absent
-- from the canonical route.
create or replace function public.trg_clear_stale_device_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_active = true
     and coalesce(new.approval_status, 'approved') = 'approved'
     and new.revoked_at is null
     and new.last_seen_at is not null
     and (old.last_seen_at is null or new.last_seen_at > old.last_seen_at) then
    new.stale_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_stale_device_on_activity on public.user_devices;
create trigger clear_stale_device_on_activity
before update of last_seen_at, is_active, approval_status
on public.user_devices
for each row
execute function public.trg_clear_stale_device_on_activity();

-- Repair devices that already checked in recently while carrying the old
-- sticky stale marker.
update public.user_devices
set stale_at = null,
    updated_at = now()
where is_active = true
  and coalesce(approval_status, 'approved') = 'approved'
  and revoked_at is null
  and stale_at is not null
  and last_seen_at >= now() - interval '90 days';

-- Existing development accounts can predate user_identity_roots even though
-- they already own a stable account signing key and an approved primary
-- device. Repair that server index automatically. The signing key is not
-- changed here; a conflicting existing root is deliberately left untouched.
do $$
declare
  v_uid uuid;
begin
  for v_uid in
    select distinct ud.user_id
    from public.user_devices ud
    where ud.is_active = true
      and coalesce(ud.approval_status, 'approved') = 'approved'
      and ud.revoked_at is null
  loop
    perform public.ensure_primary_device_exists(v_uid);
  end loop;
end;
$$;

with canonical_primary as (
  select distinct on (ud.user_id)
    ud.user_id,
    ud.device_id
  from public.user_devices ud
  where ud.is_active = true
    and ud.is_primary = true
    and coalesce(ud.approval_status, 'approved') = 'approved'
    and ud.revoked_at is null
    and ud.stale_at is null
    and ud.device_public_key is not null
    and length(trim(ud.device_public_key)) > 0
  order by ud.user_id, ud.last_seen_at desc nulls last, ud.created_at desc
), account_root as (
  select
    cp.user_id,
    cp.device_id,
    upk.signing_key
  from canonical_primary cp
  join public.user_public_keys upk
    on upk.user_id = cp.user_id
   and upk.is_active = true
  where upk.signing_key is not null
    and length(trim(upk.signing_key)) >= 32
)
insert into public.user_identity_roots (
  user_id,
  primary_device_id,
  identity_pub_b64,
  generation,
  created_at,
  updated_at
)
select
  ar.user_id,
  ar.device_id,
  ar.signing_key,
  1,
  now(),
  now()
from account_root ar
on conflict (user_id) do update
set primary_device_id = excluded.primary_device_id,
    updated_at = now()
where public.user_identity_roots.identity_pub_b64 = excluded.identity_pub_b64;

create or replace function public.aegis_send_message(
  p_message_id uuid,
  p_conversation_id uuid,
  p_body text,
  p_image_url text default null,
  p_extra jsonb default '{}'::jsonb,
  p_copies jsonb default '[]'::jsonb,
  p_sender_device_id text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_message_id uuid;
  v_existing_sender uuid;
  v_existing_conversation uuid;
  v_existing_body text;
  v_copies jsonb := coalesce(p_copies, '[]'::jsonb);
  v_copies_count integer := 0;
  v_distinct_copy_count integer := 0;
  v_bad_copy_count integer := 0;
  v_uncovered_participants integer := 0;
  v_is_zeus_conversation boolean := false;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_message_id is null or p_conversation_id is null then
    raise exception 'AEGIS_STABLE_UUID_REQUIRED' using errcode = '23502';
  end if;

  if not exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id
      and cp.user_id = v_uid
  ) then
    raise exception 'sender_not_conversation_participant' using errcode = '42501';
  end if;

  -- Stable UUID retries acknowledge only the exact immutable ciphertext.
  select m.sender_id, m.conversation_id, m.body
    into v_existing_sender, v_existing_conversation, v_existing_body
  from public.messages m
  where m.id = p_message_id;

  if found then
    if v_existing_sender = v_uid
       and v_existing_conversation = p_conversation_id
       and v_existing_body = p_body then
      return p_message_id;
    end if;
    raise exception 'MESSAGE_ID_CONFLICT' using errcode = '23505';
  end if;

  select exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id
      and cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
  ) into v_is_zeus_conversation;

  if v_is_zeus_conversation then
    insert into public.messages (
      id, conversation_id, sender_id, body, image_url, body_kind,
      view_once, expires_at, document_url, document_name, document_mime,
      document_size_bytes, archive_body
    ) values (
      p_message_id,
      p_conversation_id,
      v_uid,
      p_body,
      nullif(p_image_url, ''),
      'system',
      coalesce((p_extra->>'view_once')::boolean, false),
      nullif(p_extra->>'expires_at', '')::timestamptz,
      nullif(p_extra->>'document_url', ''),
      nullif(p_extra->>'document_name', ''),
      nullif(p_extra->>'document_mime', ''),
      nullif(p_extra->>'document_size_bytes', '')::int,
      nullif(p_extra->>'archive_body', '')
    ) returning id into v_message_id;
    return v_message_id;
  end if;

  if not public.is_supported_aegis_message(p_body, 'multi_device') then
    raise exception 'AEGIS_WIRE_FORMAT_REJECTED' using errcode = '23514';
  end if;

  if p_sender_device_id is null or length(trim(p_sender_device_id)) < 8 then
    raise exception 'E2EE_SENDER_DEVICE_REQUIRED' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.get_signed_device_list(v_uid) own_device
    where own_device.device_id = p_sender_device_id
  ) then
    raise exception 'E2EE_SENDER_DEVICE_NOT_TRUSTED' using errcode = '23514';
  end if;

  if jsonb_typeof(v_copies) <> 'array' then
    raise exception 'E2EE_INVALID_DEVICE_COPY' using errcode = '23514';
  end if;

  with supplied as (
    select *
    from jsonb_to_recordset(v_copies) as c(
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

  -- Every supplied row is fail-closed: it must be a participant device from
  -- the canonical signed route, and it must use the authenticated sender
  -- DeviceID plus a supported Aegis envelope.
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
     or not (
       c.encrypted_body like 'aegis1.ratchet.%'
       or c.encrypted_body like 'aegis1.init.v1.%'
     )
     or not exists (
       select 1
       from public.conversation_participants cp
       cross join lateral public.get_signed_device_list(cp.user_id) dl
       where cp.conversation_id = p_conversation_id
         and cp.user_id = c.recipient_user_id
         and dl.device_id = c.recipient_device_id
     );

  if v_bad_copy_count > 0 then
    raise exception 'E2EE_INVALID_DEVICE_COPY'
      using errcode = '23514',
            detail = format('%s invalid or unauthenticated device copy row(s).', v_bad_copy_count);
  end if;

  -- Availability rule: omit a stale device, never an entire recipient. This
  -- preserves confidentiality/authenticity while removing the all-devices DoS
  -- edge that caused E2EE_DEVICE_COPIES_UNAVAILABLE.
  with supplied_users as (
    select distinct c.recipient_user_id
    from jsonb_to_recordset(v_copies) as c(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    )
  )
  select count(*) into v_uncovered_participants
  from (
    select distinct cp.user_id
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id
      and cp.user_id <> v_uid
  ) participant
  where not exists (
    select 1
    from supplied_users su
    where su.recipient_user_id = participant.user_id
  );

  if v_uncovered_participants > 0 then
    raise exception 'E2EE_PARTICIPANT_ROUTE_UNAVAILABLE'
      using errcode = '23514',
            detail = format('%s participant(s) received no authenticated device copy.', v_uncovered_participants);
  end if;

  insert into public.messages (
    id, conversation_id, sender_id, body, image_url, body_kind,
    view_once, expires_at, document_url, document_name, document_mime,
    document_size_bytes, archive_body
  ) values (
    p_message_id,
    p_conversation_id,
    v_uid,
    p_body,
    nullif(p_image_url, ''),
    'multi_device',
    coalesce((p_extra->>'view_once')::boolean, false),
    nullif(p_extra->>'expires_at', '')::timestamptz,
    nullif(p_extra->>'document_url', ''),
    nullif(p_extra->>'document_name', ''),
    nullif(p_extra->>'document_mime', ''),
    nullif(p_extra->>'document_size_bytes', '')::int,
    nullif(p_extra->>'archive_body', '')
  ) returning id into v_message_id;

  insert into public.message_device_copies (
    message_id, recipient_user_id, recipient_device_id,
    sender_user_id, sender_device_id, encrypted_body
  )
  select
    v_message_id,
    c.recipient_user_id,
    c.recipient_device_id,
    v_uid,
    c.sender_device_id,
    c.encrypted_body
  from jsonb_to_recordset(v_copies) as c(
    recipient_user_id uuid,
    recipient_device_id text,
    sender_device_id text,
    encrypted_body text
  );

  return v_message_id;
end;
$$;

revoke all on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text
) from public;
grant execute on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text
) to authenticated;

comment on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text
) is 'Aegis v1 atomic send: canonical-device subset, at least one authenticated copy per participant.';

comment on function public.trg_clear_stale_device_on_activity() is
  'Clears stale_at when an approved non-revoked device checks in through authenticated registration.';

commit;
