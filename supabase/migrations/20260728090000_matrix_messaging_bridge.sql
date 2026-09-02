begin;

create table if not exists public.matrix_user_mappings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  matrix_user_id text not null unique
    check (matrix_user_id ~ '^@[a-z0-9._=-]+:[a-z0-9.-]+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.matrix_room_mappings (
  conversation_id uuid primary key
    references public.conversations(id) on delete cascade,
  matrix_room_id text not null unique
    check (matrix_room_id ~ '^!.+:.+$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.matrix_user_mappings enable row level security;
alter table public.matrix_room_mappings enable row level security;

revoke all on public.matrix_user_mappings from anon, authenticated;
revoke all on public.matrix_room_mappings from anon, authenticated;

create or replace function public.get_matrix_conversation_route(p_conversation_id uuid)
returns table (
  matrix_room_id text,
  participant_user_id uuid,
  participant_matrix_user_id text
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    room.matrix_room_id,
    participant.user_id,
    mapping.matrix_user_id
  from public.conversation_participants caller
  join public.conversation_participants participant
    on participant.conversation_id = caller.conversation_id
   and participant.user_id <> auth.uid()
  left join public.matrix_user_mappings mapping
    on mapping.user_id = participant.user_id
  left join public.matrix_room_mappings room
    on room.conversation_id = caller.conversation_id
  where caller.conversation_id = p_conversation_id
    and caller.user_id = auth.uid();
$$;

revoke all on function public.get_matrix_conversation_route(uuid) from public;
grant execute on function public.get_matrix_conversation_route(uuid) to authenticated;

create or replace function public.claim_matrix_conversation_room(
  p_conversation_id uuid,
  p_matrix_room_id text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room_id text;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_matrix_room_id is null or p_matrix_room_id !~ '^!.+:.+$' then
    raise exception 'INVALID_MATRIX_ROOM_ID' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id = auth.uid()
  ) then
    raise exception 'NOT_A_CONVERSATION_PARTICIPANT' using errcode = '42501';
  end if;

  insert into public.matrix_room_mappings (
    conversation_id,
    matrix_room_id,
    created_by
  )
  values (p_conversation_id, p_matrix_room_id, auth.uid())
  on conflict (conversation_id) do nothing;

  select mapping.matrix_room_id
    into strict v_room_id
  from public.matrix_room_mappings mapping
  where mapping.conversation_id = p_conversation_id;

  return v_room_id;
end;
$$;

revoke all on function public.claim_matrix_conversation_room(uuid, text) from public;
grant execute on function public.claim_matrix_conversation_room(uuid, text) to authenticated;

comment on table public.matrix_user_mappings is
  'Opaque bridge between ForSure accounts and local Matrix identities. No access tokens or keys.';
comment on table public.matrix_room_mappings is
  'One authoritative Matrix room per ForSure conversation; prevents mixed Aegis/Matrix delivery.';

commit;

