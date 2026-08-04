begin;

-- Aegis durable device inbox.
--
-- Additive migration: encrypted parents remain in public.messages and
-- per-device ciphertext remains in public.message_device_copies. This table
-- stores delivery state only; it never duplicates plaintext, private keys,
-- recovery secrets or media keys.

alter table public.message_device_copies
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;

create table if not exists public.aegis_device_inbox (
  copy_id uuid primary key
    references public.message_device_copies(id) on delete cascade,
  message_id uuid not null
    references public.messages(id) on delete cascade,
  recipient_user_id uuid not null
    references auth.users(id) on delete cascade,
  recipient_device_id text not null,
  state text not null default 'pending'
    check (state in ('pending', 'acked')),
  available_at timestamptz not null default now(),
  last_synced_at timestamptz,
  sync_attempt_count integer not null default 0
    check (sync_attempt_count >= 0),
  acked_at timestamptz,
  read_at timestamptz,
  expires_at timestamptz not null default (now() + interval '90 days'),
  created_at timestamptz not null default now(),
  unique (message_id, recipient_user_id, recipient_device_id),
  check (length(recipient_device_id) between 8 and 256),
  check (
    (state = 'pending' and acked_at is null)
    or (state = 'acked' and acked_at is not null)
  )
);

alter table public.aegis_device_inbox enable row level security;
revoke all on table public.aegis_device_inbox
from public, anon, authenticated;

create index if not exists aegis_device_inbox_pending_idx
on public.aegis_device_inbox (
  recipient_user_id,
  recipient_device_id,
  available_at,
  copy_id
)
where state = 'pending';

create index if not exists aegis_device_inbox_expiry_idx
on public.aegis_device_inbox (expires_at, copy_id);

create index if not exists aegis_device_inbox_acked_idx
on public.aegis_device_inbox (acked_at, copy_id)
where state = 'acked';

create or replace function public.trg_aegis_enqueue_device_copy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expires_at timestamptz;
begin
  select coalesce(message.expires_at, new.created_at + interval '90 days')
    into v_expires_at
  from public.messages message
  where message.id = new.message_id;

  if v_expires_at is null then
    v_expires_at := new.created_at + interval '90 days';
  end if;

  insert into public.aegis_device_inbox (
    copy_id,
    message_id,
    recipient_user_id,
    recipient_device_id,
    state,
    available_at,
    acked_at,
    read_at,
    expires_at,
    created_at
  ) values (
    new.id,
    new.message_id,
    new.recipient_user_id,
    new.recipient_device_id,
    case when new.delivered_at is null then 'pending' else 'acked' end,
    new.created_at,
    new.delivered_at,
    new.read_at,
    v_expires_at,
    new.created_at
  )
  on conflict (copy_id) do nothing;

  return new;
end;
$$;

revoke all on function public.trg_aegis_enqueue_device_copy()
from public, anon, authenticated;

drop trigger if exists aegis_enqueue_device_copy
on public.message_device_copies;

create trigger aegis_enqueue_device_copy
after insert on public.message_device_copies
for each row
execute function public.trg_aegis_enqueue_device_copy();

-- Backfill capsules created after the clean rebuild but before this migration.
insert into public.aegis_device_inbox (
  copy_id,
  message_id,
  recipient_user_id,
  recipient_device_id,
  state,
  available_at,
  acked_at,
  read_at,
  expires_at,
  created_at
)
select
  copy.id,
  copy.message_id,
  copy.recipient_user_id,
  copy.recipient_device_id,
  case when copy.delivered_at is null then 'pending' else 'acked' end,
  copy.created_at,
  copy.delivered_at,
  copy.read_at,
  coalesce(message.expires_at, copy.created_at + interval '90 days'),
  copy.created_at
from public.message_device_copies copy
join public.messages message on message.id = copy.message_id
on conflict (copy_id) do nothing;

create or replace function public.aegis_sync_device(
  p_device_id text,
  p_limit integer default 100
)
returns table (
  copy_id uuid,
  message_id uuid,
  conversation_id uuid,
  sender_user_id uuid,
  sender_device_id text,
  encrypted_body text,
  parent_body text,
  image_url text,
  document_url text,
  document_name text,
  document_mime text,
  document_size_bytes integer,
  archive_body text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.get_sesame_device_list(v_uid) device
    where device.device_id = v_device_id
      and device.is_routable = true
  ) then
    raise exception 'E2EE_DEVICE_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  update public.user_devices device
  set last_seen_at = now(),
      updated_at = now()
  where device.user_id = v_uid
    and device.device_id = v_device_id
    and device.revoked_at is null;

  return query
  with candidates as (
    select inbox.copy_id
    from public.aegis_device_inbox inbox
    where inbox.recipient_user_id = v_uid
      and inbox.recipient_device_id = v_device_id
      and inbox.state = 'pending'
      and inbox.expires_at > now()
    order by inbox.available_at, inbox.copy_id
    limit v_limit
    for update of inbox skip locked
  ),
  touched as (
    update public.aegis_device_inbox inbox
    set last_synced_at = now(),
        sync_attempt_count = inbox.sync_attempt_count + 1
    from candidates
    where inbox.copy_id = candidates.copy_id
    returning inbox.copy_id, inbox.expires_at
  )
  select
    copy.id,
    copy.message_id,
    message.conversation_id,
    copy.sender_user_id,
    copy.sender_device_id,
    copy.encrypted_body,
    message.body,
    message.image_url,
    message.document_url,
    message.document_name,
    message.document_mime,
    message.document_size_bytes,
    message.archive_body,
    copy.created_at,
    touched.expires_at
  from touched
  join public.message_device_copies copy on copy.id = touched.copy_id
  join public.messages message
    on message.id = copy.message_id
   and message.sender_id = copy.sender_user_id
  join public.conversation_participants participant
    on participant.conversation_id = message.conversation_id
   and participant.user_id = v_uid
  order by copy.created_at, copy.id;
end;
$$;

revoke all on function public.aegis_sync_device(text, integer)
from public, anon;
grant execute on function public.aegis_sync_device(text, integer)
to authenticated;

create or replace function public.aegis_ack_device_messages(
  p_device_id text,
  p_message_ids uuid[],
  p_mark_read boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  with acknowledged as (
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
      )
    returning inbox.copy_id, inbox.acked_at, inbox.read_at
  )
  update public.message_device_copies copy
  set delivered_at = coalesce(copy.delivered_at, acknowledged.acked_at),
      read_at = case
        when p_mark_read then coalesce(copy.read_at, acknowledged.read_at, now())
        else copy.read_at
      end
  from acknowledged
  where copy.id = acknowledged.copy_id;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.aegis_ack_device_messages(
  text, uuid[], boolean
) from public, anon;
grant execute on function public.aegis_ack_device_messages(
  text, uuid[], boolean
) to authenticated;

create or replace function public.aegis_prune_device_inbox()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted_copies bigint := 0;
  v_deleted_messages bigint := 0;
begin
  if auth.role() <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  with doomed as (
    select inbox.copy_id
    from public.aegis_device_inbox inbox
    where inbox.expires_at <= now()
       or (
         inbox.state = 'acked'
         and inbox.acked_at < now() - interval '30 days'
       )
    order by inbox.copy_id
    limit 10000
  )
  delete from public.message_device_copies copy
  using doomed
  where copy.id = doomed.copy_id;

  get diagnostics v_deleted_copies = row_count;

  delete from public.messages message
  where message.body_kind = 'multi_device'
    and message.expires_at is not null
    and message.expires_at <= now()
    and not exists (
      select 1
      from public.message_device_copies copy
      where copy.message_id = message.id
    );

  get diagnostics v_deleted_messages = row_count;

  return jsonb_build_object(
    'deleted_device_copies', v_deleted_copies,
    'deleted_expired_messages', v_deleted_messages
  );
end;
$$;

revoke all on function public.aegis_prune_device_inbox()
from public, anon, authenticated;
grant execute on function public.aegis_prune_device_inbox()
to service_role;

comment on table public.aegis_device_inbox is
  'Durable delivery state for encrypted Aegis device capsules. Contains no plaintext or private key material.';
comment on function public.aegis_sync_device(text, integer) is
  'Returns only pending encrypted capsules for the authenticated authorized device and records bounded delivery attempts.';
comment on function public.aegis_ack_device_messages(text, uuid[], boolean) is
  'Idempotently acknowledges ciphertext persisted by the authenticated device.';
comment on function public.aegis_prune_device_inbox() is
  'Maintenance function for expired or long-acked encrypted device capsules.';

notify pgrst, 'reload schema';

commit;