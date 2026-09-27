-- Explicit per-recipient delivery state and user-controlled message blocking.
--
-- Security invariants:
--   * block relationships are private to the blocker;
--   * a sender only learns that the recipient blocked them after an attempted
--     message commit, as explicitly requested by the product;
--   * blocked recipients never receive a Libsignal device copy or wake-up;
--   * delivered/read state can only advance through the device-bound ACK RPC;
--   * message contents and key material remain unchanged and encrypted.

begin;

create table if not exists public.user_message_blocks (
  blocker_user_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  constraint user_message_blocks_distinct_users
    check (blocker_user_id <> blocked_user_id)
);

create index if not exists idx_user_message_blocks_blocked
  on public.user_message_blocks (blocked_user_id, blocker_user_id);

alter table public.user_message_blocks enable row level security;
revoke all on table public.user_message_blocks from public, anon, authenticated;
grant select on table public.user_message_blocks to authenticated;

drop policy if exists user_message_blocks_select_own on public.user_message_blocks;
create policy user_message_blocks_select_own
  on public.user_message_blocks
  for select
  to authenticated
  using (blocker_user_id = auth.uid());

drop policy if exists user_message_blocks_insert_own on public.user_message_blocks;
drop policy if exists user_message_blocks_delete_own on public.user_message_blocks;

create table if not exists public.message_recipient_states (
  message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'sent'
    check (state in ('sent', 'delivered', 'read', 'blocked')),
  blocked_reason text
    check (blocked_reason is null or blocked_reason in (
      'recipient_block', 'sender_block', 'delivery_policy'
    )),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  blocked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (message_id, recipient_user_id),
  constraint message_recipient_states_distinct_users
    check (sender_user_id <> recipient_user_id),
  constraint message_recipient_states_block_consistency
    check (
      (state = 'blocked' and blocked_reason is not null and blocked_at is not null)
      or
      (state <> 'blocked' and blocked_reason is null and blocked_at is null)
    )
);

create index if not exists idx_message_recipient_states_sender
  on public.message_recipient_states (sender_user_id, conversation_id, updated_at desc);
create index if not exists idx_message_recipient_states_recipient
  on public.message_recipient_states (recipient_user_id, conversation_id, updated_at desc);

alter table public.message_recipient_states enable row level security;
alter table public.message_recipient_states replica identity full;
revoke all on table public.message_recipient_states from public, anon, authenticated;
grant select on table public.message_recipient_states to authenticated;

drop policy if exists message_recipient_states_visible_parties
  on public.message_recipient_states;
create policy message_recipient_states_visible_parties
  on public.message_recipient_states
  for select
  to authenticated
  using (
    public.is_conversation_participant(conversation_id, auth.uid())
    and (
      sender_user_id = auth.uid()
      or (recipient_user_id = auth.uid() and state <> 'blocked')
    )
  );

-- Preserve an accurate baseline for already committed messages. Historical
-- rows can prove delivery/read only from durable per-device timestamps; the
-- old parent status is intentionally not treated as a read receipt.
insert into public.message_recipient_states (
  message_id,
  conversation_id,
  sender_user_id,
  recipient_user_id,
  state,
  blocked_reason,
  sent_at,
  delivered_at,
  read_at,
  blocked_at,
  updated_at
)
select
  message.id,
  message.conversation_id,
  message.sender_id,
  participant.user_id,
  case
    when message.status = 'blocked' then 'blocked'
    when delivery.read_at is not null then 'read'
    when delivery.delivered_at is not null then 'delivered'
    else 'sent'
  end,
  case when message.status = 'blocked' then 'delivery_policy' else null end,
  case when message.status <> 'blocked' then message.created_at else null end,
  case when message.status <> 'blocked' then delivery.delivered_at else null end,
  case when message.status <> 'blocked' then delivery.read_at else null end,
  case when message.status = 'blocked' then message.created_at else null end,
  greatest(
    message.created_at,
    coalesce(delivery.delivered_at, message.created_at),
    coalesce(delivery.read_at, message.created_at)
  )
from public.messages message
join auth.users sender_user on sender_user.id = message.sender_id
join public.conversation_participants participant
  on participant.conversation_id = message.conversation_id
 and participant.user_id <> message.sender_id
join auth.users recipient_user on recipient_user.id = participant.user_id
left join lateral (
  select
    max(copy.delivered_at) as delivered_at,
    max(copy.read_at) as read_at
  from public.message_device_copies copy
  where copy.message_id = message.id
    and copy.recipient_user_id = participant.user_id
) delivery on true
on conflict (message_id, recipient_user_id) do nothing;

-- Evaluate parent visibility with owner privileges so the deliberately private
-- blocked state cannot be hidden from the messages RLS check by its own RLS.
-- The function remains bound to auth.uid(); callers cannot inspect another
-- user's block relationship or retrieve any message data through it.
create or replace function public.aegis_can_view_message(
  p_message_id uuid,
  p_conversation_id uuid,
  p_sender_user_id uuid,
  p_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select auth.uid() is not null
    and public.is_conversation_participant(p_conversation_id, auth.uid())
    and (
      p_sender_user_id = auth.uid()
      or (
        coalesce(p_status, '') <> 'blocked'
        and not exists (
          select 1
          from public.message_recipient_states recipient_state
          where recipient_state.message_id = p_message_id
            and recipient_state.recipient_user_id = auth.uid()
            and recipient_state.state = 'blocked'
        )
      )
    );
$function$;

revoke all on function public.aegis_can_view_message(uuid, uuid, uuid, text)
from public, anon;
grant execute on function public.aegis_can_view_message(uuid, uuid, uuid, text)
to authenticated;

alter table public.messages
  add column if not exists aegis_sender_device_id text;

-- A blocked recipient must not be able to query the encrypted parent. This is
-- important for group conversations where the parent remains globally
-- delivered but that recipient has no corresponding Libsignal capsule.
drop policy if exists msg_select_if_participant on public.messages;
create policy msg_select_if_participant
  on public.messages
  for select
  to authenticated
  using (
    public.aegis_can_view_message(
      messages.id,
      messages.conversation_id,
      messages.sender_id,
      messages.status
    )
  );

-- Legacy client-side receipt writes are removed. Receipts are produced only by
-- the device-bound ACK RPC below.
do $policies$
declare policy_row record;
begin
  for policy_row in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'message_read_receipts'
  loop
    execute format(
      'drop policy if exists %I on public.message_read_receipts',
      policy_row.policyname
    );
  end loop;
end
$policies$;

alter table public.message_read_receipts enable row level security;
revoke all on table public.message_read_receipts from public, anon, authenticated;
grant select on table public.message_read_receipts to authenticated;

create policy message_read_receipts_visible_parties
  on public.message_read_receipts
  for select
  to authenticated
  using (
    public.is_conversation_participant(conversation_id, auth.uid())
    and exists (
      select 1
      from public.messages message
      where message.id = message_read_receipts.message_id
        and (
          message.sender_id = auth.uid()
          or message_read_receipts.user_id = auth.uid()
        )
    )
  );

-- Internal relation helper. It is deliberately not executable by API roles.
-- The sender/recipient ordering matters: recipient_block means the intended
-- recipient blocked the sender; sender_block is the inverse.
create or replace function public.aegis_message_block_reason(
  p_sender_user_id uuid,
  p_recipient_user_id uuid
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when p_sender_user_id is null
      or p_recipient_user_id is null
      or p_sender_user_id = p_recipient_user_id then null
    when exists (
      select 1
      from public.user_message_blocks block
      where block.blocker_user_id = p_recipient_user_id
        and block.blocked_user_id = p_sender_user_id
    ) then 'recipient_block'
    when exists (
      select 1
      from public.user_message_blocks block
      where block.blocker_user_id = p_sender_user_id
        and block.blocked_user_id = p_recipient_user_id
    ) then 'sender_block'
    else null
  end;
$function$;

revoke all on function public.aegis_message_block_reason(uuid, uuid)
from public, anon, authenticated;

create or replace function public.aegis_set_user_message_block(
  p_target_user_id uuid,
  p_blocked boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_changed integer := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_target_user_id is null or p_target_user_id = v_uid then
    raise exception 'MESSAGE_BLOCK_TARGET_INVALID' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users where id = p_target_user_id) then
    raise exception 'MESSAGE_BLOCK_TARGET_UNKNOWN' using errcode = '22023';
  end if;

  if coalesce(p_blocked, false) then
    insert into public.user_message_blocks (blocker_user_id, blocked_user_id)
    values (v_uid, p_target_user_id)
    on conflict do nothing;
  else
    delete from public.user_message_blocks block
    where block.blocker_user_id = v_uid
      and block.blocked_user_id = p_target_user_id;
  end if;

  get diagnostics v_changed = row_count;
  if v_changed > 0 then
    -- Block changes are part of the canonical route. Incrementing the same
    -- counter used by device changes invalidates every cached conversation
    -- route without disclosing who performed the block.
    perform public.bump_aegis_user_route_version(v_uid);
  end if;

  return coalesce(p_blocked, false);
end;
$function$;

revoke all on function public.aegis_set_user_message_block(uuid, boolean)
from public, anon;
grant execute on function public.aegis_set_user_message_block(uuid, boolean)
to authenticated;

create or replace function public.aegis_get_user_message_block_status(
  p_target_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  return exists (
    select 1
    from public.user_message_blocks block
    where block.blocker_user_id = v_uid
      and block.blocked_user_id = p_target_user_id
  );
end;
$function$;

revoke all on function public.aegis_get_user_message_block_status(uuid)
from public, anon;
grant execute on function public.aegis_get_user_message_block_status(uuid)
to authenticated;

create or replace function public.aegis_resolve_conversation_route(
  p_conversation_id uuid,
  p_sender_device_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_sender_device text := nullif(trim(coalesce(p_sender_device_id, '')), '');
  v_route_version text;
  v_participants jsonb;
  v_self_routable boolean := false;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_conversation_id is null then
    raise exception 'conversation_required' using errcode = '23502';
  end if;
  if not exists (
    select 1
    from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id = v_uid
  ) then
    raise exception 'not_conversation_participant' using errcode = '42501';
  end if;

  v_route_version := public.get_aegis_conversation_route_version(p_conversation_id);

  select coalesce(
    jsonb_agg(participant_row order by participant_row->>'user_id'),
    '[]'::jsonb
  )
  into v_participants
  from (
    select jsonb_build_object(
      'user_id', peer.user_id,
      'is_self', peer.user_id = v_uid,
      'routable_count', case
        when peer.block_reason is not null then 0
        else coalesce(devices.routable_count, 0)
      end,
      'total_count', case
        when peer.block_reason is not null then 0
        else coalesce(devices.total_count, 0)
      end,
      'reason', case
        when peer.block_reason = 'recipient_block' then 'BLOCKED_SENDER'
        when peer.block_reason = 'sender_block' then 'BLOCKED_BY_SELF'
        when coalesce(devices.total_count, 0) = 0 then 'NO_DEVICE_IDENTITY'
        when coalesce(devices.routable_count, 0) = 0 then 'DEVICES_NOT_ROUTABLE'
        else 'OK'
      end,
      'devices', case
        when peer.block_reason is not null then '[]'::jsonb
        else coalesce(devices.devices, '[]'::jsonb)
      end
    ) as participant_row
    from (
      select distinct
        participant.user_id,
        public.aegis_message_block_reason(v_uid, participant.user_id)
          as block_reason
      from public.conversation_participants participant
      where participant.conversation_id = p_conversation_id
        and participant.user_id <>
          '00000000-0000-0000-0000-000000000001'::uuid
    ) peer
    left join lateral (
      select
        count(*) as total_count,
        count(*) filter (where device.is_routable) as routable_count,
        jsonb_agg(
          jsonb_build_object(
            'device_id', device.device_id,
            'device_public_key', device.device_public_key,
            'device_signing_key', device.device_signing_key,
            'device_authorization_signature', device.device_authorization_signature,
            'last_seen_at', device.last_seen_at,
            'account_identity_key', device.account_identity_key,
            'account_signing_key', device.account_signing_key,
            'account_fingerprint', device.account_fingerprint,
            'account_binding_signature', device.account_binding_signature,
            'account_binding_version', device.account_binding_version,
            'is_routable', device.is_routable
          )
          order by device.device_id
        ) as devices
      from public.get_sesame_device_list(peer.user_id) device
      where peer.block_reason is null
    ) devices on true
  ) route_rows;

  if v_sender_device is not null then
    select exists (
      select 1
      from public.get_sesame_device_list(v_uid) own_device
      where own_device.device_id = v_sender_device
        and own_device.is_routable = true
    ) into v_self_routable;
  end if;

  return jsonb_build_object(
    'route_version', v_route_version,
    'self_user_id', v_uid,
    'sender_device_id', v_sender_device,
    'sender_device_routable', v_self_routable,
    'participants', v_participants
  );
end;
$function$;

revoke all on function public.aegis_resolve_conversation_route(uuid, text)
from public, anon;
grant execute on function public.aegis_resolve_conversation_route(uuid, text)
to authenticated;

create or replace function public.aegis_build_message_commit_receipt(
  p_message_id uuid,
  p_request_digest text,
  p_existing boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_total integer := 0;
  v_blocked integer := 0;
  v_blocked_recipients jsonb := '[]'::jsonb;
  v_delivery_state text := 'sent';
begin
  select
    count(*),
    count(*) filter (where recipient_state.state = 'blocked'),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'user_id', recipient_state.recipient_user_id,
          'reason', recipient_state.blocked_reason
        )
        order by recipient_state.recipient_user_id
      ) filter (where recipient_state.state = 'blocked'),
      '[]'::jsonb
    )
  into v_total, v_blocked, v_blocked_recipients
  from public.message_recipient_states recipient_state
  where recipient_state.message_id = p_message_id;

  v_delivery_state := case
    when v_total > 0 and v_blocked = v_total then 'blocked'
    when v_blocked > 0 then 'partial'
    else 'sent'
  end;

  return jsonb_build_object(
    'state', 'committed',
    'message_id', p_message_id,
    'request_digest', p_request_digest,
    'existing', p_existing,
    'delivery_state', v_delivery_state,
    'blocked_recipients', v_blocked_recipients
  );
end;
$function$;

revoke all on function public.aegis_build_message_commit_receipt(uuid, text, boolean)
from public, anon, authenticated;

create or replace function public.aegis_send_message(
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
as $function$
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
  v_expected_count integer := 0;
  v_peer_count integer := 0;
  v_blocked_peer_count integer := 0;
  v_parent_status text;
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

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'recipient_user_id', copy.recipient_user_id,
        'recipient_device_id', copy.recipient_device_id,
        'sender_device_id', copy.sender_device_id,
        'encrypted_body', copy.encrypted_body
      )
      order by copy.recipient_user_id, copy.recipient_device_id,
               copy.sender_device_id, copy.encrypted_body
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

  perform pg_advisory_xact_lock(hashtextextended(p_message_id::text, 0));

  select message.sender_id, message.aegis_request_digest
    into v_existing_sender, v_existing_digest
  from public.messages message
  where message.id = p_message_id;

  if found then
    if v_existing_sender = v_uid
       and v_existing_digest is not null
       and v_existing_digest = v_request_digest then
      return public.aegis_build_message_commit_receipt(
        p_message_id,
        v_request_digest,
        true
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

  insert into public.aegis_user_route_versions (user_id, route_version)
  select participant.user_id, 0
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
  select count(*), count(distinct (recipient_user_id, recipient_device_id))
    into v_copies_count, v_distinct_copy_count
  from supplied;

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
     or copy.encrypted_body is null
     or not public.is_supported_aegis_device_copy(copy.encrypted_body);

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
      and public.aegis_message_block_reason(v_uid, participant.user_id) is null
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

  select
    count(*) filter (where participant.user_id <> v_uid),
    count(*) filter (
      where participant.user_id <> v_uid
        and public.aegis_message_block_reason(v_uid, participant.user_id)
          is not null
    )
  into v_peer_count, v_blocked_peer_count
  from public.conversation_participants participant
  where participant.conversation_id = p_conversation_id;

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral public.get_sesame_device_list(participant.user_id) device
    where participant.conversation_id = p_conversation_id
      and device.is_routable = true
      and (
        participant.user_id = v_uid
        or public.aegis_message_block_reason(v_uid, participant.user_id) is null
      )
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
    (select count(*) from expected),
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
  into v_expected_count, v_missing_count, v_unexpected_count
  from expected
  left join supplied
    on supplied.recipient_user_id = expected.recipient_user_id
   and supplied.recipient_device_id = expected.recipient_device_id;

  if v_expected_count = 0
     and (v_peer_count = 0 or v_blocked_peer_count <> v_peer_count) then
    raise exception 'E2EE_NO_SECURE_TARGET' using errcode = '23514';
  end if;

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
    aegis_request_digest, aegis_sender_device_id
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
    v_request_digest,
    trim(p_sender_device_id)
  )
  returning status into v_parent_status;

  insert into public.message_recipient_states (
    message_id,
    conversation_id,
    sender_user_id,
    recipient_user_id,
    state,
    blocked_reason,
    sent_at,
    blocked_at,
    updated_at
  )
  select
    p_message_id,
    p_conversation_id,
    v_uid,
    participant.user_id,
    case
      when public.aegis_message_block_reason(v_uid, participant.user_id)
        is not null then 'blocked'
      when v_parent_status = 'blocked' then 'blocked'
      else 'sent'
    end,
    case
      when public.aegis_message_block_reason(v_uid, participant.user_id)
        is not null
        then public.aegis_message_block_reason(v_uid, participant.user_id)
      when v_parent_status = 'blocked' then 'delivery_policy'
      else null
    end,
    case
      when public.aegis_message_block_reason(v_uid, participant.user_id)
        is null and v_parent_status <> 'blocked' then now()
      else null
    end,
    case
      when public.aegis_message_block_reason(v_uid, participant.user_id)
        is not null or v_parent_status = 'blocked' then now()
      else null
    end,
    now()
  from public.conversation_participants participant
  where participant.conversation_id = p_conversation_id
    and participant.user_id <> v_uid;

  insert into public.message_device_copies (
    message_id,
    recipient_user_id,
    recipient_device_id,
    sender_user_id,
    sender_device_id,
    encrypted_body
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
  )
  where copy.recipient_user_id = v_uid
     or exists (
       select 1
       from public.message_recipient_states recipient_state
       where recipient_state.message_id = p_message_id
         and recipient_state.recipient_user_id = copy.recipient_user_id
         and recipient_state.state <> 'blocked'
     );

  return public.aegis_build_message_commit_receipt(
    p_message_id,
    v_request_digest,
    false
  );
end;
$function$;

revoke all on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) from public, anon;
grant execute on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) to authenticated;

create or replace function public.trg_aegis_require_pinned_device_copies()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_sender_device_id text;
  v_current_route_version text;
  v_expected_count integer := 0;
  v_actual_count integer := 0;
  v_missing_count integer := 0;
  v_unexpected_count integer := 0;
  v_duplicate_count integer := 0;
begin
  if new.body_kind <> 'multi_device' then
    return null;
  end if;

  v_current_route_version :=
    public.get_aegis_conversation_route_version(new.conversation_id);
  if new.aegis_route_version is null
     or new.aegis_route_version is distinct from v_current_route_version then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = 'Aegis parent is not pinned to the current route version.';
  end if;

  v_sender_device_id := nullif(trim(coalesce(new.aegis_sender_device_id, '')), '');
  if v_sender_device_id is null then
    select min(copy.sender_device_id)
      into v_sender_device_id
    from public.message_device_copies copy
    where copy.message_id = new.id
      and copy.sender_user_id = new.sender_id;
  end if;

  if v_sender_device_id is null or length(v_sender_device_id) < 8 then
    raise exception 'E2EE_DEVICE_COPIES_UNAVAILABLE'
      using errcode = '23514',
            detail = 'Aegis parent has no sender-bound device route.';
  end if;

  select
    count(*),
    count(*) - count(distinct (copy.recipient_user_id, copy.recipient_device_id))
  into v_actual_count, v_duplicate_count
  from public.message_device_copies copy
  where copy.message_id = new.id;

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral public.get_sesame_device_list(participant.user_id) device
    where participant.conversation_id = new.conversation_id
      and device.is_routable
      and not (
        participant.user_id = new.sender_id
        and device.device_id = v_sender_device_id
      )
      and not exists (
        select 1
        from public.message_recipient_states recipient_state
        where recipient_state.message_id = new.id
          and recipient_state.recipient_user_id = participant.user_id
          and recipient_state.state = 'blocked'
      )
  )
  select
    (select count(*) from expected),
    count(*) filter (where actual.id is null)
  into v_expected_count, v_missing_count
  from expected route
  left join public.message_device_copies actual
    on actual.message_id = new.id
   and actual.recipient_user_id = route.recipient_user_id
   and actual.recipient_device_id = route.recipient_device_id
   and actual.sender_user_id = new.sender_id
   and actual.sender_device_id = v_sender_device_id;

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral public.get_sesame_device_list(participant.user_id) device
    where participant.conversation_id = new.conversation_id
      and device.is_routable
      and not (
        participant.user_id = new.sender_id
        and device.device_id = v_sender_device_id
      )
      and not exists (
        select 1
        from public.message_recipient_states recipient_state
        where recipient_state.message_id = new.id
          and recipient_state.recipient_user_id = participant.user_id
          and recipient_state.state = 'blocked'
      )
  )
  select count(*)
    into v_unexpected_count
  from public.message_device_copies actual
  where actual.message_id = new.id
    and (
      actual.sender_user_id <> new.sender_id
      or actual.sender_device_id <> v_sender_device_id
      or not exists (
        select 1
        from expected route
        where route.recipient_user_id = actual.recipient_user_id
          and route.recipient_device_id = actual.recipient_device_id
      )
    );

  if v_actual_count <> v_expected_count
     or v_missing_count > 0
     or v_unexpected_count > 0
     or v_duplicate_count > 0 then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Pinned Aegis route mismatch: %s expected, %s actual, %s missing, %s unexpected, %s duplicate.',
              v_expected_count,
              v_actual_count,
              v_missing_count,
              v_unexpected_count,
              v_duplicate_count
            );
  end if;

  return null;
end;
$function$;

revoke all on function public.trg_aegis_require_pinned_device_copies()
from public, anon, authenticated;

create or replace function public.route_direct_message_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_recipient_id uuid;
  v_is_group boolean := false;
  v_is_friend boolean := false;
begin
  new.status := 'delivered';
  if new.sender_id = '00000000-0000-0000-0000-000000000001'::uuid then
    return new;
  end if;

  select conversation.is_group
    into v_is_group
  from public.conversations conversation
  where conversation.id = new.conversation_id;

  if coalesce(v_is_group, false) then
    return new;
  end if;

  select participant.user_id
    into v_recipient_id
  from public.conversation_participants participant
  where participant.conversation_id = new.conversation_id
    and participant.user_id <> new.sender_id
  order by participant.joined_at, participant.user_id
  limit 1;

  if v_recipient_id is null
     or v_recipient_id = '00000000-0000-0000-0000-000000000001'::uuid then
    return new;
  end if;

  if public.aegis_message_block_reason(new.sender_id, v_recipient_id)
     is not null then
    new.status := 'blocked';
    return new;
  end if;

  if coalesce(public.is_user_minor(v_recipient_id), false) then
    select exists (
      select 1
      from public.friendships friendship
      where friendship.status = 'accepted'
        and (
          (friendship.requester_id = new.sender_id
            and friendship.addressee_id = v_recipient_id)
          or
          (friendship.requester_id = v_recipient_id
            and friendship.addressee_id = new.sender_id)
        )
    ) into v_is_friend;

    if not v_is_friend then
      new.status := 'blocked';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.route_direct_message_delivery()
from public, anon, authenticated;

create or replace function public.aegis_ack_device_messages(
  p_device_id text,
  p_message_ids uuid[],
  p_mark_read boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_updated integer := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if coalesce(array_length(p_message_ids, 1), 0) = 0
     or array_length(p_message_ids, 1) > 250 then
    raise exception 'AEGIS_ACK_BATCH_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.get_sesame_device_list(v_uid) device
    where device.device_id = v_device_id
      and device.is_routable = true
  ) then
    raise exception 'E2EE_DEVICE_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  update public.aegis_device_inbox inbox
  set state = 'acked',
      acked_at = coalesce(inbox.acked_at, now()),
      read_at = case
        when p_mark_read then coalesce(inbox.read_at, now())
        else inbox.read_at
      end
  where inbox.recipient_user_id = v_uid
    and inbox.recipient_device_id = v_device_id
    and inbox.message_id = any(p_message_ids)
    and (
      inbox.state = 'pending'
      or (p_mark_read and inbox.read_at is null)
    );

  get diagnostics v_updated = row_count;

  update public.message_device_copies copy
  set delivered_at = coalesce(copy.delivered_at, inbox.acked_at, now()),
      read_at = case
        when p_mark_read then coalesce(copy.read_at, inbox.read_at, now())
        else copy.read_at
      end
  from public.aegis_device_inbox inbox
  where copy.id = inbox.copy_id
    and inbox.recipient_user_id = v_uid
    and inbox.recipient_device_id = v_device_id
    and inbox.message_id = any(p_message_ids)
    and inbox.acked_at is not null;

  update public.message_recipient_states recipient_state
  set state = case when p_mark_read then 'read' else 'delivered' end,
      delivered_at = coalesce(recipient_state.delivered_at, now()),
      read_at = case
        when p_mark_read then coalesce(recipient_state.read_at, now())
        else recipient_state.read_at
      end,
      updated_at = now()
  where recipient_state.recipient_user_id = v_uid
    and recipient_state.message_id = any(p_message_ids)
    and recipient_state.state <> 'blocked'
    and (
      (not p_mark_read and recipient_state.state = 'sent')
      or (p_mark_read and recipient_state.state <> 'read')
    )
    and exists (
      select 1
      from public.aegis_device_inbox inbox
      where inbox.recipient_user_id = v_uid
        and inbox.recipient_device_id = v_device_id
        and inbox.message_id = recipient_state.message_id
        and inbox.acked_at is not null
    );

  if p_mark_read then
    insert into public.message_read_receipts (
      message_id,
      conversation_id,
      user_id,
      device_id,
      read_at
    )
    select distinct
      message.id,
      message.conversation_id,
      v_uid,
      v_device_id,
      coalesce(inbox.read_at, now())
    from public.messages message
    join public.aegis_device_inbox inbox
      on inbox.message_id = message.id
     and inbox.recipient_user_id = v_uid
     and inbox.recipient_device_id = v_device_id
    where message.id = any(p_message_ids)
      and inbox.read_at is not null
    on conflict (message_id, user_id, device_id) do update
    set read_at = least(
      public.message_read_receipts.read_at,
      excluded.read_at
    );
  end if;

  return v_updated;
end;
$function$;

revoke all on function public.aegis_ack_device_messages(text, uuid[], boolean)
from public, anon;
grant execute on function public.aegis_ack_device_messages(text, uuid[], boolean)
to authenticated;

-- A fully blocked view-once send has no recipient payload by design. Partial
-- group sends still stage only the unblocked recipients' device copies.
create or replace function public.stage_aegis_view_once_payload()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_payload_count integer := 0;
begin
  if new.view_once is not true then
    return new;
  end if;

  if exists (
    select 1
    from public.message_recipient_states recipient_state
    where recipient_state.message_id = new.id
  ) and not exists (
    select 1
    from public.message_recipient_states recipient_state
    where recipient_state.message_id = new.id
      and recipient_state.state <> 'blocked'
  ) then
    return new;
  end if;

  if new.body_kind is distinct from 'multi_device'
     or new.aegis_request_digest is null
     or nullif(new.image_url, '') is null
     or nullif(new.document_url, '') is not null then
    raise exception 'AEGIS_VIEW_ONCE_MEDIA_REQUIRED' using errcode = '23514';
  end if;

  insert into public.aegis_view_once_payloads (
    message_id,
    conversation_id,
    sender_user_id,
    recipient_user_id,
    parent_body,
    image_url,
    device_copies
  )
  select
    new.id,
    new.conversation_id,
    new.sender_id,
    copy.recipient_user_id,
    new.body,
    new.image_url,
    jsonb_agg(
      jsonb_build_object(
        'recipient_device_id', copy.recipient_device_id,
        'sender_device_id', copy.sender_device_id,
        'encrypted_body', copy.encrypted_body
      )
      order by copy.recipient_device_id, copy.sender_device_id
    )
  from public.message_device_copies copy
  where copy.message_id = new.id
    and copy.recipient_user_id <> new.sender_id
    and not exists (
      select 1
      from public.message_recipient_states recipient_state
      where recipient_state.message_id = new.id
        and recipient_state.recipient_user_id = copy.recipient_user_id
        and recipient_state.state = 'blocked'
    )
  group by copy.recipient_user_id;

  get diagnostics v_payload_count = row_count;
  if v_payload_count = 0 then
    raise exception 'AEGIS_VIEW_ONCE_RECIPIENT_PAYLOAD_MISSING'
      using errcode = '23514';
  end if;

  delete from public.message_device_copies where message_id = new.id;
  delete from public.message_archives where message_id = new.id;

  update public.messages
  set body = '🔒 Vue unique',
      body_kind = 'view_once',
      image_url = null,
      document_url = null,
      document_name = null,
      document_mime = null,
      document_size_bytes = null,
      archive_body = null
  where id = new.id;

  return new;
end;
$function$;

revoke all on function public.stage_aegis_view_once_payload()
from public, anon, authenticated;

-- The conversation summary RPC previously bypassed RLS and trusted its user
-- argument. Bind it to auth.uid() and omit messages blocked for that viewer.
create or replace function public.get_conversations_with_details(p_user_id uuid)
returns table (
  conv_id uuid,
  conv_created_at timestamptz,
  conv_updated_at timestamptz,
  is_group boolean,
  conv_name text,
  created_by uuid,
  other_user_id uuid,
  other_name text,
  other_avatar text,
  last_message_body text,
  last_message_at timestamptz,
  last_message_sender uuid,
  unread_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with viewer as (
    select auth.uid() as user_id
    where auth.uid() is not null
      and auth.uid() = p_user_id
  ),
  my_convs as (
    select participant.conversation_id, participant.last_read_at
    from public.conversation_participants participant
    join viewer on viewer.user_id = participant.user_id
  ),
  visible_messages as (
    select message.*
    from public.messages message
    join my_convs mine on mine.conversation_id = message.conversation_id
    where message.sender_id = p_user_id
       or (
         message.status <> 'blocked'
         and not exists (
           select 1
           from public.message_recipient_states recipient_state
           where recipient_state.message_id = message.id
             and recipient_state.recipient_user_id = p_user_id
             and recipient_state.state = 'blocked'
         )
       )
  ),
  last_msgs as (
    select distinct on (message.conversation_id)
      message.conversation_id,
      message.body,
      message.created_at,
      message.sender_id
    from visible_messages message
    order by message.conversation_id, message.created_at desc
  ),
  unreads as (
    select message.conversation_id, count(*) as cnt
    from visible_messages message
    join my_convs mine on mine.conversation_id = message.conversation_id
    where message.sender_id <> p_user_id
      and (mine.last_read_at is null or message.created_at > mine.last_read_at)
      and message.status = 'delivered'
    group by message.conversation_id
  ),
  other_parts as (
    select distinct on (participant.conversation_id)
      participant.conversation_id,
      participant.user_id,
      profile.name,
      profile.avatar_url
    from public.conversation_participants participant
    join my_convs mine on mine.conversation_id = participant.conversation_id
    left join public.profiles profile on profile.user_id = participant.user_id
    where participant.user_id <> p_user_id
    order by participant.conversation_id, participant.joined_at
  )
  select
    conversation.id,
    conversation.created_at,
    conversation.updated_at,
    conversation.is_group,
    conversation.name,
    conversation.created_by,
    other_part.user_id,
    coalesce(
      case
        when other_part.user_id =
          '00000000-0000-0000-0000-000000000001'::uuid
          then 'Zeus ⚡'
        else other_part.name
      end,
      'Unknown'
    ),
    other_part.avatar_url,
    last_message.body,
    last_message.created_at,
    last_message.sender_id,
    coalesce(unread.cnt, 0)
  from public.conversations conversation
  join my_convs mine on mine.conversation_id = conversation.id
  left join other_parts other_part
    on other_part.conversation_id = conversation.id
  left join last_msgs last_message
    on last_message.conversation_id = conversation.id
  left join unreads unread
    on unread.conversation_id = conversation.id
  order by coalesce(last_message.created_at, conversation.updated_at) desc;
$function$;

revoke all on function public.get_conversations_with_details(uuid)
from public, anon;
grant execute on function public.get_conversations_with_details(uuid)
to authenticated;

do $publication$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_recipient_states'
  ) then
    alter publication supabase_realtime
      add table public.message_recipient_states;
  end if;
end
$publication$;

commit;
