begin;

create table if not exists public.message_edits (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  editor_user_id uuid not null references auth.users(id) on delete cascade,
  revision integer not null check (revision > 0 and revision <= 100),
  encrypted_body text not null check (char_length(encrypted_body) between 1 and 65536),
  archive_body text,
  edited_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (message_id, revision)
);

create index if not exists message_edits_message_revision_idx
  on public.message_edits(message_id, revision desc);
create index if not exists message_edits_conversation_time_idx
  on public.message_edits(conversation_id, edited_at desc);

create table if not exists public.message_edit_device_copies (
  edit_id uuid not null references public.message_edits(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_device_id text not null,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  sender_device_id text not null,
  encrypted_body text not null check (char_length(encrypted_body) between 1 and 262144),
  created_at timestamptz not null default now(),
  primary key (edit_id, recipient_device_id)
);

create index if not exists message_edit_copies_recipient_idx
  on public.message_edit_device_copies(recipient_user_id, recipient_device_id, created_at desc);
create index if not exists message_edit_copies_sender_idx
  on public.message_edit_device_copies(sender_user_id, created_at desc);

create table if not exists public.message_edit_archives (
  edit_id uuid not null references public.message_edits(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  archive_body text not null check (char_length(archive_body) between 1 and 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (edit_id, user_id)
);

alter table public.message_edits enable row level security;
alter table public.message_edit_device_copies enable row level security;
alter table public.message_edit_archives enable row level security;

revoke all on public.message_edits from anon, authenticated;
revoke all on public.message_edit_device_copies from anon, authenticated;
revoke all on public.message_edit_archives from anon, authenticated;
grant select on public.message_edits to authenticated;
grant select on public.message_edit_device_copies to authenticated;
grant select, insert, update on public.message_edit_archives to authenticated;

drop policy if exists message_edits_select_participant on public.message_edits;
create policy message_edits_select_participant
on public.message_edits for select to authenticated
using (
  exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = message_edits.conversation_id
      and cp.user_id = auth.uid()
  )
);

drop policy if exists message_edit_copies_select_owner on public.message_edit_device_copies;
create policy message_edit_copies_select_owner
on public.message_edit_device_copies for select to authenticated
using (recipient_user_id = auth.uid() or sender_user_id = auth.uid());

drop policy if exists message_edit_archives_select_own on public.message_edit_archives;
create policy message_edit_archives_select_own
on public.message_edit_archives for select to authenticated
using (user_id = auth.uid());

drop policy if exists message_edit_archives_insert_own on public.message_edit_archives;
create policy message_edit_archives_insert_own
on public.message_edit_archives for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.message_edits me
    join public.conversation_participants cp
      on cp.conversation_id = me.conversation_id
     and cp.user_id = auth.uid()
    where me.id = message_edit_archives.edit_id
  )
);

drop policy if exists message_edit_archives_update_own on public.message_edit_archives;
create policy message_edit_archives_update_own
on public.message_edit_archives for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create or replace function public.touch_message_edit_archive_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_message_edit_archives_updated_at on public.message_edit_archives;
create trigger trg_message_edit_archives_updated_at
before update on public.message_edit_archives
for each row execute function public.touch_message_edit_archive_updated_at();

create or replace function public.send_message_edit_with_device_copies(
  p_edit_id uuid,
  p_message_id uuid,
  p_encrypted_body text,
  p_archive_body text default null,
  p_copies jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_message public.messages%rowtype;
  v_revision integer;
  v_edit public.message_edits%rowtype;
  v_copy jsonb;
  v_recipient_user_id uuid;
  v_recipient_device_id text;
  v_sender_user_id uuid;
  v_sender_device_id text;
  v_copy_body text;
  v_inserted integer := 0;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  if p_edit_id is null or p_message_id is null then
    raise exception 'INVALID_EDIT_ID' using errcode = '22023';
  end if;

  if p_encrypted_body is null or char_length(p_encrypted_body) = 0 or char_length(p_encrypted_body) > 65536 then
    raise exception 'INVALID_EDIT_ENVELOPE' using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_copies, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_DEVICE_COPIES' using errcode = '22023';
  end if;

  if jsonb_array_length(coalesce(p_copies, '[]'::jsonb)) > 100 then
    raise exception 'TOO_MANY_DEVICE_COPIES' using errcode = '54000';
  end if;

  select * into v_message
  from public.messages
  where id = p_message_id
  for update;

  if not found then
    raise exception 'MESSAGE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_message.sender_id <> v_uid then
    raise exception 'ONLY_SENDER_CAN_EDIT' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = v_message.conversation_id
      and cp.user_id = v_uid
  ) then
    raise exception 'NOT_CONVERSATION_PARTICIPANT' using errcode = '42501';
  end if;

  if clock_timestamp() > v_message.created_at + interval '15 minutes' then
    raise exception 'EDIT_WINDOW_EXPIRED' using errcode = '22023';
  end if;

  if v_message.image_url is not null
     or coalesce(v_message.view_once, false)
     or v_message.document_url is not null then
    raise exception 'MEDIA_MESSAGES_CANNOT_BE_EDITED' using errcode = '22023';
  end if;

  select coalesce(max(revision), 0) + 1
    into v_revision
  from public.message_edits
  where message_id = p_message_id;

  if v_revision > 100 then
    raise exception 'EDIT_REVISION_LIMIT_REACHED' using errcode = '54000';
  end if;

  insert into public.message_edits (
    id,
    message_id,
    conversation_id,
    editor_user_id,
    revision,
    encrypted_body,
    archive_body
  ) values (
    p_edit_id,
    p_message_id,
    v_message.conversation_id,
    v_uid,
    v_revision,
    p_encrypted_body,
    nullif(p_archive_body, '')
  )
  returning * into v_edit;

  for v_copy in
    select value from jsonb_array_elements(coalesce(p_copies, '[]'::jsonb))
  loop
    begin
      v_recipient_user_id := (v_copy ->> 'recipient_user_id')::uuid;
      v_recipient_device_id := nullif(v_copy ->> 'recipient_device_id', '');
      v_sender_user_id := (v_copy ->> 'sender_user_id')::uuid;
      v_sender_device_id := nullif(v_copy ->> 'sender_device_id', '');
      v_copy_body := nullif(v_copy ->> 'encrypted_body', '');
    exception when others then
      raise exception 'INVALID_DEVICE_COPY_SHAPE' using errcode = '22023';
    end;

    if v_sender_user_id <> v_uid
       or v_recipient_device_id is null
       or v_sender_device_id is null
       or v_copy_body is null
       or char_length(v_copy_body) > 262144 then
      raise exception 'INVALID_DEVICE_COPY' using errcode = '22023';
    end if;

    if not exists (
      select 1
      from public.conversation_participants cp
      where cp.conversation_id = v_message.conversation_id
        and cp.user_id = v_recipient_user_id
    ) then
      raise exception 'COPY_RECIPIENT_NOT_PARTICIPANT' using errcode = '42501';
    end if;

    if not exists (
      select 1
      from public.user_devices ud
      where ud.user_id = v_recipient_user_id
        and ud.device_id = v_recipient_device_id
        and ud.is_active = true
        and ud.approval_status = 'approved'
        and ud.revoked_at is null
    ) then
      raise exception 'COPY_RECIPIENT_DEVICE_INVALID' using errcode = '42501';
    end if;

    insert into public.message_edit_device_copies (
      edit_id,
      recipient_user_id,
      recipient_device_id,
      sender_user_id,
      sender_device_id,
      encrypted_body
    ) values (
      v_edit.id,
      v_recipient_user_id,
      v_recipient_device_id,
      v_uid,
      v_sender_device_id,
      v_copy_body
    )
    on conflict (edit_id, recipient_device_id) do nothing;

    v_inserted := v_inserted + 1;
  end loop;

  if exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = v_message.conversation_id
      and cp.user_id <> v_uid
      and exists (
        select 1 from public.user_devices ud
        where ud.user_id = cp.user_id
          and ud.is_active = true
          and ud.approval_status = 'approved'
          and ud.revoked_at is null
      )
      and not exists (
        select 1 from public.message_edit_device_copies c
        where c.edit_id = v_edit.id
          and c.recipient_user_id = cp.user_id
      )
  ) then
    raise exception 'MISSING_PARTICIPANT_DEVICE_COPY' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'id', v_edit.id,
    'message_id', v_edit.message_id,
    'conversation_id', v_edit.conversation_id,
    'revision', v_edit.revision,
    'edited_at', v_edit.edited_at,
    'copies_inserted', v_inserted
  );
end;
$$;

revoke all on function public.send_message_edit_with_device_copies(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.send_message_edit_with_device_copies(uuid, uuid, text, text, jsonb) to authenticated;

-- Realtime is used only as a wake-up signal; RLS still governs row visibility.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_edits'
  ) then
    alter publication supabase_realtime add table public.message_edits;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_edit_device_copies'
  ) then
    alter publication supabase_realtime add table public.message_edit_device_copies;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_edit_archives'
  ) then
    alter publication supabase_realtime add table public.message_edit_archives;
  end if;
end;
$$;

commit;
