-- Encrypted direct-message requests.
--
-- The server never inspects plaintext. It routes the first Aegis ciphertext
-- from a non-contact to a request/spam inbox using relationship and velocity
-- metadata only. Existing conversations are accepted during backfill so this
-- migration cannot demote a working chat.

begin;

create table if not exists public.direct_message_requests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique
    references public.conversations(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'dismissed', 'spam', 'blocked')),
  first_message_id uuid
    references public.messages(id) on delete set null
    deferrable initially deferred,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  responded_at timestamptz,
  reported_at timestamptz,
  constraint direct_message_requests_distinct_users
    check (sender_user_id <> recipient_user_id)
);

create index if not exists idx_direct_message_requests_recipient_inbox
  on public.direct_message_requests (recipient_user_id, status, updated_at desc);
create index if not exists idx_direct_message_requests_sender_velocity
  on public.direct_message_requests (sender_user_id, created_at desc);

-- Risk details are deliberately isolated from the user-visible request row.
create table if not exists public.direct_message_request_risk (
  request_id uuid primary key
    references public.direct_message_requests(id) on delete cascade,
  score smallint not null default 0 check (score between 0 and 100),
  reason_codes text[] not null default '{}'::text[],
  evaluated_at timestamptz not null default now()
);

alter table public.direct_message_requests enable row level security;
alter table public.direct_message_request_risk enable row level security;

revoke all on table public.direct_message_requests
from public, anon, authenticated;
revoke all on table public.direct_message_request_risk
from public, anon, authenticated;

drop policy if exists direct_message_requests_visible_parties
  on public.direct_message_requests;
-- No direct Data API policy is created. The RPC below exposes only the
-- current user's masked inbox state and keeps anti-spam classification private.

-- Keep the request inbox aligned with every existing block/unblock surface.
-- Accepted chats keep their relationship state and are merely paused by the
-- canonical block table; pending requests are hidden while either side blocks.
create or replace function public.sync_direct_message_request_block_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    update public.direct_message_requests request
    set status = 'blocked',
        responded_at = coalesce(request.responded_at, now()),
        updated_at = now()
    where request.status in ('pending', 'spam')
      and (
        (request.sender_user_id = new.blocker_user_id
          and request.recipient_user_id = new.blocked_user_id)
        or
        (request.sender_user_id = new.blocked_user_id
          and request.recipient_user_id = new.blocker_user_id)
      );
    return new;
  end if;

  if not exists (
    select 1
    from public.user_message_blocks block
    where (block.blocker_user_id = old.blocker_user_id
        and block.blocked_user_id = old.blocked_user_id)
       or (block.blocker_user_id = old.blocked_user_id
        and block.blocked_user_id = old.blocker_user_id)
  ) then
    update public.direct_message_requests request
    set status = case
          when coalesce(risk.score, 0) >= 50 then 'spam'
          else 'pending'
        end,
        responded_at = null,
        updated_at = now()
    from public.direct_message_request_risk risk
    where request.id = risk.request_id
      and request.status = 'blocked'
      and (
        (request.sender_user_id = old.blocker_user_id
          and request.recipient_user_id = old.blocked_user_id)
        or
        (request.sender_user_id = old.blocked_user_id
          and request.recipient_user_id = old.blocker_user_id)
      );
  end if;
  return old;
end;
$function$;

revoke all on function public.sync_direct_message_request_block_state()
from public, anon, authenticated;

drop trigger if exists sync_direct_message_request_block_state
  on public.user_message_blocks;
create trigger sync_direct_message_request_block_state
  after insert or delete on public.user_message_blocks
  for each row
  execute function public.sync_direct_message_request_block_state();

-- Preserve every established conversation. Only a future first message in an
-- empty non-friend DM can enter the request workflow.
insert into public.direct_message_requests (
  conversation_id,
  sender_user_id,
  recipient_user_id,
  status,
  first_message_id,
  created_at,
  updated_at,
  responded_at
)
select
  conversation.id,
  first_message.sender_id,
  recipient.user_id,
  'accepted',
  first_message.id,
  first_message.created_at,
  greatest(conversation.updated_at, first_message.created_at),
  now()
from public.conversations conversation
join lateral (
  select message.id, message.sender_id, message.created_at
  from public.messages message
  where message.conversation_id = conversation.id
  order by message.created_at, message.id
  limit 1
) first_message on true
join lateral (
  select participant.user_id
  from public.conversation_participants participant
  where participant.conversation_id = conversation.id
    and participant.user_id <> first_message.sender_id
  order by participant.joined_at, participant.user_id
  limit 1
) recipient on true
where conversation.is_group = false
  and first_message.sender_id <>
    '00000000-0000-0000-0000-000000000001'::uuid
  and recipient.user_id <>
    '00000000-0000-0000-0000-000000000001'::uuid
  and (
    select count(*)
    from public.conversation_participants participant_count
    where participant_count.conversation_id = conversation.id
  ) = 2
on conflict (conversation_id) do nothing;

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
  v_messages_allowed text := 'everyone';
  v_request public.direct_message_requests%rowtype;
  v_request_exists boolean := false;
  v_daily_requests integer := 0;
  v_recent_reports integer := 0;
  v_account_is_new boolean := false;
  v_spam_score integer := 0;
  v_spam_reasons text[] := '{}'::text[];
  v_content_kind text := 'text';
begin
  new.status := 'delivered';

  if new.sender_id =
    '00000000-0000-0000-0000-000000000001'::uuid then
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
     or v_recipient_id =
       '00000000-0000-0000-0000-000000000001'::uuid then
    return new;
  end if;

  if public.aegis_message_block_reason(new.sender_id, v_recipient_id)
     is not null then
    new.status := 'blocked';
    return new;
  end if;

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

  -- Keep the existing child-safety boundary fail-closed.
  if coalesce(public.is_user_minor(v_recipient_id), false)
     and not v_is_friend then
    new.status := 'blocked';
    return new;
  end if;

  select coalesce(settings.messages_allowed, 'everyone')
    into v_messages_allowed
  from public.privacy_settings settings
  where settings.user_id = v_recipient_id;
  v_messages_allowed := coalesce(v_messages_allowed, 'everyone');

  if v_messages_allowed = 'nobody'
     or (v_messages_allowed = 'friends' and not v_is_friend) then
    new.status := 'blocked';
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('dm-request:' || new.conversation_id::text, 0)
  );

  select request.*
    into v_request
  from public.direct_message_requests request
  where request.conversation_id = new.conversation_id
  for update;
  v_request_exists := found;

  if v_request_exists then
    if v_request.status = 'accepted' then
      return new;
    end if;

    -- A friendship established after the first request opens the route, but
    -- never overrides an explicit dismissal or block.
    if v_is_friend and v_request.status in ('pending', 'spam') then
      update public.direct_message_requests request
      set status = 'accepted',
          responded_at = coalesce(request.responded_at, now()),
          updated_at = now()
      where request.id = v_request.id;
      return new;
    end if;

    -- A reply by the recipient is an explicit acceptance even if an older
    -- client did not display the request action bar.
    if v_request.recipient_user_id = new.sender_id then
      update public.direct_message_requests request
      set status = 'accepted',
          responded_at = coalesce(request.responded_at, now()),
          updated_at = now()
      where request.id = v_request.id;
      return new;
    end if;

    if v_request.sender_user_id = new.sender_id then
      if v_request.status in ('pending', 'spam') then
        raise exception 'MESSAGE_REQUEST_PENDING' using errcode = 'P0001';
      end if;
      raise exception 'MESSAGE_REQUEST_UNAVAILABLE' using errcode = 'P0001';
    end if;

    new.status := 'blocked';
    return new;
  end if;

  if v_is_friend then
    insert into public.direct_message_requests (
      conversation_id,
      sender_user_id,
      recipient_user_id,
      status,
      first_message_id,
      responded_at
    ) values (
      new.conversation_id,
      new.sender_id,
      v_recipient_id,
      'accepted',
      new.id,
      now()
    );
    return new;
  end if;

  begin
    v_content_kind := nullif(new.body::jsonb->>'contentKind', '');
  exception when others then
    v_content_kind := null;
  end;

  -- Established conversations remain backward compatible, but starting a
  -- new request requires authenticated routing metadata from an updated
  -- client. Missing metadata must never be guessed as text.
  if v_content_kind is null then
    raise exception 'MESSAGE_REQUEST_CLIENT_UPDATE_REQUIRED' using errcode = 'P0001';
  end if;

  -- Message requests start with one text message. Attachments, calls and view
  -- once payloads become available only after the recipient accepts.
  if v_content_kind <> 'text'
     or new.image_url is not null
     or new.document_url is not null
     or coalesce(new.view_once, false) then
    raise exception 'MESSAGE_REQUEST_TEXT_ONLY' using errcode = 'P0001';
  end if;

  -- The quota is per sender, not per conversation. Serializing on the sender
  -- prevents parallel first-message requests from racing past the daily cap.
  perform pg_advisory_xact_lock(
    hashtextextended('dm-request-sender:' || new.sender_id::text, 0)
  );

  select count(*)
    into v_daily_requests
  from public.direct_message_requests request
  where request.sender_user_id = new.sender_id
    and request.created_at >= now() - interval '24 hours';

  if v_daily_requests >= 20 then
    raise exception 'MESSAGE_REQUEST_RATE_LIMITED' using errcode = 'P0001';
  end if;

  select count(*)
    into v_recent_reports
  from public.direct_message_requests request
  where request.sender_user_id = new.sender_id
    and request.reported_at >= now() - interval '30 days';

  select coalesce(account.created_at >= now() - interval '24 hours', false)
    into v_account_is_new
  from auth.users account
  where account.id = new.sender_id;

  v_spam_score := least(
    100,
    (v_daily_requests * 5)
      + (v_recent_reports * 25)
      + case when v_account_is_new then 15 else 0 end
  );

  if v_daily_requests >= 8 then
    v_spam_reasons := array_append(v_spam_reasons, 'request_velocity');
  end if;
  if v_recent_reports > 0 then
    v_spam_reasons := array_append(v_spam_reasons, 'recipient_reports');
  end if;
  if v_account_is_new then
    v_spam_reasons := array_append(v_spam_reasons, 'new_account');
  end if;

  insert into public.direct_message_requests (
    conversation_id,
    sender_user_id,
    recipient_user_id,
    status,
    first_message_id
  ) values (
    new.conversation_id,
    new.sender_id,
    v_recipient_id,
    case when v_spam_score >= 50 then 'spam' else 'pending' end,
    new.id
  )
  returning * into v_request;

  insert into public.direct_message_request_risk (
    request_id,
    score,
    reason_codes
  ) values (
    v_request.id,
    v_spam_score,
    v_spam_reasons
  )
  on conflict (request_id) do update
  set score = excluded.score,
      reason_codes = excluded.reason_codes,
      evaluated_at = now();

  return new;
end;
$function$;

revoke all on function public.route_direct_message_delivery()
from public, anon, authenticated;

-- Device ACKs may confirm delivery of a request, but reading its preview must
-- not reveal a read receipt before acceptance.
create or replace function public.guard_pending_request_read_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.state = 'read'
     and exists (
       select 1
       from public.direct_message_requests request
       where request.conversation_id = new.conversation_id
         and request.sender_user_id = new.sender_user_id
         and request.recipient_user_id = new.recipient_user_id
         and request.status in ('pending', 'spam')
     ) then
    if old.state = 'sent' then
      new.state := 'delivered';
      new.delivered_at := coalesce(old.delivered_at, new.delivered_at, now());
    else
      new.state := old.state;
    end if;
    new.read_at := old.read_at;
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_pending_request_read_state()
from public, anon, authenticated;

drop trigger if exists guard_pending_request_read_state
  on public.message_recipient_states;
create trigger guard_pending_request_read_state
  before update on public.message_recipient_states
  for each row
  execute function public.guard_pending_request_read_state();

create or replace function public.guard_pending_request_read_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.messages message
    join public.direct_message_requests request
      on request.conversation_id = message.conversation_id
     and request.sender_user_id = message.sender_id
     and request.recipient_user_id = new.user_id
    where message.id = new.message_id
      and request.status in ('pending', 'spam')
  ) then
    return null;
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_pending_request_read_receipt()
from public, anon, authenticated;

drop trigger if exists guard_pending_request_read_receipt
  on public.message_read_receipts;
create trigger guard_pending_request_read_receipt
  before insert or update on public.message_read_receipts
  for each row
  execute function public.guard_pending_request_read_receipt();

-- The sender can inspect its own per-device delivery rows. Keep the raw
-- device-copy timestamp from becoming a side-channel around the guarded
-- aggregate/read-receipt tables.
create or replace function public.guard_pending_request_device_copy_read()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.read_at is not null
     and old.read_at is null
     and exists (
       select 1
       from public.messages message
       join public.direct_message_requests request
         on request.conversation_id = message.conversation_id
        and request.sender_user_id = message.sender_id
        and request.recipient_user_id = new.recipient_user_id
       where message.id = new.message_id
         and request.status in ('pending', 'spam')
     ) then
    new.read_at := old.read_at;
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_pending_request_device_copy_read()
from public, anon, authenticated;

drop trigger if exists guard_pending_request_device_copy_read
  on public.message_device_copies;
create trigger guard_pending_request_device_copy_read
  before update on public.message_device_copies
  for each row
  execute function public.guard_pending_request_device_copy_read();

-- Calls are accepted only for friends or accepted message relationships.
create or replace function public.guard_unaccepted_direct_call()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_is_group boolean := false;
  v_is_friend boolean := false;
  v_request_status text;
begin
  select conversation.is_group
    into v_is_group
  from public.conversations conversation
  where conversation.id::text = new.conversation_id;

  if coalesce(v_is_group, false) then
    return new;
  end if;

  -- Do not leak whether the callee blocked the caller or tightened their
  -- privacy settings. The same generic acceptance error covers every denial.
  if public.aegis_message_block_reason(new.caller_id, new.callee_id)
     is not null then
    raise exception 'MESSAGE_REQUEST_ACCEPTANCE_REQUIRED' using errcode = 'P0001';
  end if;

  select request.status
    into v_request_status
  from public.direct_message_requests request
  where request.conversation_id::text = new.conversation_id;

  if v_request_status = 'accepted' then
    return new;
  end if;

  select exists (
    select 1
    from public.friendships friendship
    where friendship.status = 'accepted'
      and (
        (friendship.requester_id = new.caller_id
          and friendship.addressee_id = new.callee_id)
        or
        (friendship.requester_id = new.callee_id
          and friendship.addressee_id = new.caller_id)
      )
  ) into v_is_friend;

  if not v_is_friend then
    raise exception 'MESSAGE_REQUEST_ACCEPTANCE_REQUIRED' using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

revoke all on function public.guard_unaccepted_direct_call()
from public, anon, authenticated;

drop trigger if exists guard_unaccepted_direct_call on public.active_calls;
create trigger guard_unaccepted_direct_call
  before insert on public.active_calls
  for each row
  execute function public.guard_unaccepted_direct_call();

create or replace function public.get_direct_message_request_states()
returns table (
  conversation_id uuid,
  inbox_category text,
  request_role text,
  request_status text,
  can_send_text boolean,
  can_send_media boolean,
  can_call boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  with viewer as (
    select auth.uid() as user_id
    where auth.uid() is not null
  ),
  direct_conversations as (
    select
      conversation.id as conversation_id,
      viewer.user_id,
      peer.user_id as peer_user_id,
      exists (
        select 1
        from public.friendships friendship
        where friendship.status = 'accepted'
          and (
            (friendship.requester_id = viewer.user_id
              and friendship.addressee_id = peer.user_id)
            or
            (friendship.requester_id = peer.user_id
              and friendship.addressee_id = viewer.user_id)
          )
      ) as is_friend
    from viewer
    join public.conversation_participants mine
      on mine.user_id = viewer.user_id
    join public.conversations conversation
      on conversation.id = mine.conversation_id
     and conversation.is_group = false
    join lateral (
      select participant.user_id
      from public.conversation_participants participant
      where participant.conversation_id = conversation.id
        and participant.user_id <> viewer.user_id
      order by participant.joined_at, participant.user_id
      limit 1
    ) peer on true
  ),
  classified as (
    select
      direct.conversation_id,
      direct.user_id,
      direct.peer_user_id,
      direct.is_friend,
      request.sender_user_id,
      request.recipient_user_id,
      request.status
    from direct_conversations direct
    left join public.direct_message_requests request
      on request.conversation_id = direct.conversation_id
  )
  select
    classified.conversation_id,
    case
      when classified.peer_user_id =
        '00000000-0000-0000-0000-000000000001'::uuid then 'primary'
      when classified.status = 'accepted' then 'primary'
      when classified.status in ('dismissed', 'blocked') then 'hidden'
      when classified.is_friend then 'primary'
      when classified.recipient_user_id = classified.user_id
        and classified.status = 'pending' then 'requests'
      when classified.recipient_user_id = classified.user_id
        and classified.status = 'spam' then 'spam'
      when classified.sender_user_id = classified.user_id
        and classified.status in ('pending', 'spam') then 'outgoing_pending'
      when classified.status is null then 'draft_request'
      else 'hidden'
    end,
    case
      when classified.sender_user_id = classified.user_id then 'sender'
      when classified.recipient_user_id = classified.user_id then 'recipient'
      when classified.status is null then 'sender'
      else 'none'
    end,
    case
      when classified.peer_user_id =
        '00000000-0000-0000-0000-000000000001'::uuid then 'accepted'
      when classified.status = 'accepted' then 'accepted'
      when classified.status in ('dismissed', 'blocked') then classified.status
      when classified.is_friend then 'accepted'
      when classified.sender_user_id = classified.user_id then 'pending'
      when classified.status is null then 'draft'
      else classified.status
    end,
    (
      classified.peer_user_id =
        '00000000-0000-0000-0000-000000000001'::uuid
      or classified.status = 'accepted'
      or (
        classified.is_friend
        and (classified.status is null or classified.status not in ('dismissed', 'blocked'))
      )
      or classified.status is null
    ),
    (
      classified.peer_user_id =
        '00000000-0000-0000-0000-000000000001'::uuid
      or classified.status = 'accepted'
      or (
        classified.is_friend
        and (classified.status is null or classified.status not in ('dismissed', 'blocked'))
      )
    ),
    (
      classified.status = 'accepted'
      or (
        classified.is_friend
        and (classified.status is null or classified.status not in ('dismissed', 'blocked'))
      )
    )
  from classified;
$function$;

revoke all on function public.get_direct_message_request_states()
from public, anon;
grant execute on function public.get_direct_message_request_states()
to authenticated;

create or replace function public.aegis_set_direct_message_request(
  p_conversation_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_request public.direct_message_requests%rowtype;
  v_status text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_action not in ('accept', 'dismiss', 'report_spam', 'block') then
    raise exception 'MESSAGE_REQUEST_ACTION_INVALID' using errcode = '22023';
  end if;

  select request.*
    into v_request
  from public.direct_message_requests request
  where request.conversation_id = p_conversation_id
    and request.recipient_user_id = v_uid
  for update;

  if not found then
    raise exception 'MESSAGE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_request.status = 'blocked' and p_action <> 'block' then
    raise exception 'MESSAGE_REQUEST_BLOCKED' using errcode = 'P0001';
  end if;

  v_status := case p_action
    when 'accept' then 'accepted'
    when 'dismiss' then 'dismissed'
    when 'report_spam' then 'spam'
    when 'block' then 'blocked'
  end;

  update public.direct_message_requests request
  set status = v_status,
      updated_at = now(),
      responded_at = case
        when p_action in ('accept', 'dismiss', 'block')
          then coalesce(request.responded_at, now())
        else request.responded_at
      end,
      reported_at = case
        when p_action = 'report_spam' then coalesce(request.reported_at, now())
        else request.reported_at
      end
  where request.id = v_request.id;

  if p_action = 'block' then
    insert into public.user_message_blocks (blocker_user_id, blocked_user_id)
    values (v_uid, v_request.sender_user_id)
    on conflict (blocker_user_id, blocked_user_id) do nothing;
  end if;

  -- Wake clients that already subscribe to conversation updates without
  -- exposing the private risk table to Realtime.
  update public.conversations conversation
  set updated_at = now()
  where conversation.id = p_conversation_id;

  return jsonb_build_object(
    'ok', true,
    'conversation_id', p_conversation_id,
    'status', v_status
  );
end;
$function$;

revoke all on function public.aegis_set_direct_message_request(uuid, text)
from public, anon;
grant execute on function public.aegis_set_direct_message_request(uuid, text)
to authenticated;

comment on table public.direct_message_requests is
  'Metadata-only inbox routing for the first encrypted message from a non-contact.';
comment on table public.direct_message_request_risk is
  'Private metadata-only anti-spam score; never contains message plaintext or key material.';
comment on function public.get_direct_message_request_states() is
  'Returns the authenticated user inbox bucket and capabilities for direct conversations.';

commit;
