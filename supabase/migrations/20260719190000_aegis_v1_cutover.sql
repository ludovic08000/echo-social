-- Aegis v1 development cutover.
--
-- There is intentionally no compatibility reader. The application is not in
-- production and retaining an ambiguous legacy wire format would create more
-- recovery paths than useful guarantees. Message loss is accepted for this
-- cutover, so every surviving peer message has exactly one contract:
--   * one AES-256-GCM ciphertext in messages.body;
--   * one Double-Ratchet key capsule for each authenticated device;
--   * one stable UUID binding the parent, capsules, outbox and receipts.

begin;

-- Keep the signed route definition in the cutover itself. Some development
-- databases were created before the authoritative seven-argument RPC migration
-- and therefore do not have either the RPC or its canonical route helper.
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
      and not exists (
        select 1
        from public.invalid_e2ee_devices bad
        where bad.user_id = ud.user_id
          and bad.device_id = ud.device_id
      )
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

truncate table public.messages cascade;
-- Old server-verifiable PIN hashes are deliberately discarded. New rows are
-- opaque email-recovery tickets and contain no material derived from the PIN.
truncate table public.user_chat_pins;

-- Destructive development cleanup. These unused message transports and group
-- key stores predate Aegis and must not remain callable after the cutover.
drop function if exists public.send_sealed_sender_message(
  uuid, uuid, text, text, jsonb
);
drop function if exists public.mark_sealed_sender_delivered(uuid);
drop table if exists public.sealed_sender_messages cascade;
drop table if exists public.sealed_sender_events cascade;

drop trigger if exists trg_auto_enable_sender_keys_on_participants
  on public.conversation_participants;
drop function if exists public.maybe_enable_sender_keys_for_group();
drop table if exists public.sender_key_distribution cascade;
drop table if exists public.sender_key_state cascade;
alter table public.conversations drop column if exists enable_sender_keys;
drop table if exists public.e2ee_session_sync cascade;

-- Aegis authenticates and bootstraps each physical device independently.
-- The old account-wide signed prekey is therefore both unused and unsafe as a
-- fallback: it cannot prove which device owns the corresponding private key.
drop function if exists public.get_signed_prekey(uuid);
drop function if exists public.get_signed_prekey_with_fallback(uuid);
drop table if exists public.user_signed_prekeys cascade;
drop function if exists public.claim_x3dh_initial(text);

alter table public.messages
  drop constraint if exists messages_sesame_lite_body_check;

alter table public.messages
  drop constraint if exists messages_aegis_v1_body_check;

drop function if exists public.is_supported_sesame_lite_message(text, text);

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

alter table public.messages
  add constraint messages_aegis_v1_body_check
  check (public.is_supported_aegis_message(body, body_kind));

drop trigger if exists trg_enforce_sesame_lite_message_scope on public.messages;
drop trigger if exists trg_enforce_aegis_message_scope on public.messages;
drop function if exists public.enforce_sesame_lite_message_scope();

create or replace function public.enforce_aegis_message_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body jsonb;
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

create trigger trg_enforce_aegis_message_scope
before insert or update of id, conversation_id, sender_id, body, body_kind
on public.messages
for each row execute function public.enforce_aegis_message_scope();

revoke all on function public.enforce_aegis_message_scope() from public;
revoke all on function public.is_supported_aegis_message(text, text) from public;
grant execute on function public.is_supported_aegis_message(text, text) to authenticated;

alter table public.message_device_copies
  drop constraint if exists message_device_copies_sesame_lite_wire_check;

alter table public.message_device_copies
  drop constraint if exists message_device_copies_aegis_v1_wire_check;

alter table public.message_device_copies
  add constraint message_device_copies_aegis_v1_wire_check
  check (
    encrypted_body like 'aegis1.ratchet.%'
    or encrypted_body like 'aegis1.init.v1.%'
  );

-- Remove the sender-device inference wrapper. Aegis always identifies the
-- sending physical device explicitly, so the server validates the exact signed
-- device route instead of guessing it from client data.
drop function if exists public.send_message_with_device_copies(
  uuid, uuid, text, text, jsonb, jsonb
);

drop function if exists public.send_message_with_device_copies(
  uuid, uuid, text, text, jsonb, jsonb, text
);

drop function if exists public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text
);

create function public.aegis_send_message(
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
  v_expected_count integer := 0;
  v_bad_copy_count integer := 0;
  v_route_diff_count integer := 0;
  v_unroutable_participants integer := 0;
  v_is_zeus_conversation boolean := false;
  v_expected_ids jsonb := '[]'::jsonb;
  v_supplied_ids jsonb := '[]'::jsonb;
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

  -- A retry is idempotent only for the exact immutable Aegis parent. Reusing a
  -- UUID with different ciphertext must never acknowledge the earlier row.
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
    (select count(*) from (
      select distinct recipient_user_id, recipient_device_id from supplied
    ) distinct_supplied),
    (select count(*) from (
      (select recipient_user_id, recipient_device_id from expected
       except
       select recipient_user_id, recipient_device_id from supplied)
      union all
      (select recipient_user_id, recipient_device_id from supplied
       except
       select recipient_user_id, recipient_device_id from expected)
    ) route_diff),
    coalesce((
      select jsonb_agg(recipient_user_id::text || ':' || recipient_device_id
        order by recipient_user_id::text, recipient_device_id)
      from expected
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(recipient_user_id::text || ':' || recipient_device_id
        order by recipient_user_id::text, recipient_device_id)
      from supplied
    ), '[]'::jsonb)
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
     or not (
       c.encrypted_body like 'aegis1.ratchet.%'
       or c.encrypted_body like 'aegis1.init.v1.%'
     );

  if v_bad_copy_count > 0 then
    raise exception 'E2EE_INVALID_DEVICE_COPY'
      using errcode = '23514',
            detail = format('%s invalid device copy row(s).', v_bad_copy_count);
  end if;

  if v_expected_count = 0 then
    raise exception 'E2EE_NO_SECURE_TARGET' using errcode = '23514';
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

-- Peer messages can only be written through the atomic coordinator. Retain a
-- narrow direct insert policy for the explicit two-party Zeus system channel.
alter table public.messages enable row level security;
drop policy if exists "Users can send messages in their conversations" on public.messages;
drop policy if exists "msg_insert_if_participant_and_self" on public.messages;
drop policy if exists "Users can send Zeus system messages" on public.messages;
create policy "Users can send Zeus system messages"
on public.messages for insert
with check (
  auth.uid() = sender_id
  and body_kind = 'system'
  and exists (
    select 1
    from public.conversation_participants self_cp
    where self_cp.conversation_id = messages.conversation_id
      and self_cp.user_id = auth.uid()
  )
  and exists (
    select 1
    from public.conversation_participants zeus_cp
    where zeus_cp.conversation_id = messages.conversation_id
      and zeus_cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
  )
  and not exists (
    select 1
    from public.conversation_participants other_cp
    where other_cp.conversation_id = messages.conversation_id
      and other_cp.user_id not in (
        auth.uid(),
        '00000000-0000-0000-0000-000000000001'::uuid
      )
  )
);

comment on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text
) is 'Aegis Coordinator: atomically validates the signed device route and commits one stable ciphertext plus every device key capsule.';

do $aegis_comment$
begin
  if to_regclass('public.e2ee_kt_signing_keys') is not null then
    comment on table public.e2ee_kt_signing_keys is
      'Public Aegis Coordinator signing identities. Private signing material is deployment-secret only and never stored in this table.';
  end if;
end;
$aegis_comment$;

commit;
