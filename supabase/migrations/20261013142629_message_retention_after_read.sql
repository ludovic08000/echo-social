begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create schema if not exists aegis_retention;
revoke all on schema aegis_retention from public,anon;
grant usage on schema aegis_retention to authenticated;

-- Aucun rattrapage destructeur : les anciens messages gardent leur échéance.
alter table public.conversations add column if not exists disappearing_after_read boolean not null default false;
alter table public.conversations add constraint conversation_retention_duration_valid
  check(not disappearing_after_read or disappearing_seconds is null or disappearing_seconds in (0,86400,604800));
alter table public.messages add column if not exists retention_after_read_seconds integer
  check (retention_after_read_seconds in (0,86400,604800));
alter table public.messages add column if not exists retention_started_at timestamptz;

create table public.message_expiration_tombstones (
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null,
  conversation_id uuid not null,
  expired_at timestamptz not null,
  primary key(user_id,message_id)
);
alter table public.message_expiration_tombstones enable row level security;
revoke all on public.message_expiration_tombstones from public,anon,authenticated;
grant select on public.message_expiration_tombstones to authenticated;
create policy expiration_tombstones_own on public.message_expiration_tombstones
  for select to authenticated using(user_id=(select auth.uid()));
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.message_expiration_tombstones;
  end if;
end $$;

create or replace function public.set_message_expires_at() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare ttl integer; after_read boolean;
begin
  if exists(select 1 from public.message_expiration_tombstones where message_id=new.id) then
    raise exception 'MESSAGE_EXPIRED_IRREVERSIBLE';
  end if;
  select disappearing_seconds,disappearing_after_read into ttl,after_read
    from public.conversations where id=new.conversation_id;
  new.retention_after_read_seconds:=null;
  new.retention_started_at:=null;
  if after_read then
    -- Le client ne choisit ni sa politique ni l'horloge d'expiration.
    new.expires_at:=null;
    if new.body_kind='multi_device' and new.view_once is not true then
      new.retention_after_read_seconds:=ttl;
    end if;
  elsif new.expires_at is null and ttl>0 then
    new.expires_at:=now()+make_interval(secs=>ttl);
  end if;
  return new;
end $$;
revoke all on function public.set_message_expires_at() from public,anon,authenticated;

create function aegis_retention.protect_message_policy() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.retention_after_read_seconds is distinct from old.retention_after_read_seconds then
    raise exception 'MESSAGE_RETENTION_IMMUTABLE';
  end if;
  if current_user in ('authenticated','anon') and old.retention_after_read_seconds is not null
    and (new.expires_at is distinct from old.expires_at or new.retention_started_at is distinct from old.retention_started_at) then
    raise exception 'MESSAGE_RETENTION_SERVER_CLOCK_REQUIRED';
  end if;
  return new;
end $$;
revoke all on function aegis_retention.protect_message_policy() from public,anon,authenticated;
create trigger aegis_protect_message_retention before update on public.messages
for each row execute function aegis_retention.protect_message_policy();

create function aegis_retention.set_policy(p_conversation_id uuid,p_seconds integer) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode='42501'; end if;
  perform public.assert_current_login_session_approved();
  if p_seconds is not null and p_seconds not in (0,86400,604800) then
    raise exception 'RETENTION_DURATION_INVALID' using errcode='22023';
  end if;
  if not exists(select 1 from public.conversation_participants
    where conversation_id=p_conversation_id and user_id=auth.uid()) then
    raise exception 'CONVERSATION_NOT_AUTHORIZED' using errcode='42501';
  end if;
  update public.conversations set disappearing_seconds=p_seconds,disappearing_after_read=true
    where id=p_conversation_id;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  return jsonb_build_object('seconds',p_seconds,'after_read',true);
end $$;
revoke all on function aegis_retention.set_policy(uuid,integer) from public,anon,authenticated;
grant execute on function aegis_retention.set_policy(uuid,integer) to authenticated;
create function public.set_conversation_retention(p_conversation_id uuid,p_seconds integer) returns jsonb
language sql security invoker set search_path=public,pg_temp as $$
  select aegis_retention.set_policy(p_conversation_id,p_seconds);
$$;
revoke all on function public.set_conversation_retention(uuid,integer) from public,anon;
grant execute on function public.set_conversation_retention(uuid,integer) to authenticated;

-- L'ancien audit insérait un message système en clair incompatible avec Aegis.
-- Pour le nouveau mode, le réglage partagé sert de notice, sans faux message.
drop trigger if exists trg_log_disappearing_change on public.conversations;
create trigger trg_log_disappearing_change after update of disappearing_seconds on public.conversations
for each row when (new.disappearing_after_read=false) execute function public.log_disappearing_change();

create function aegis_retention.start_after_read() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare parent public.messages%rowtype;
begin
  if new.state<>'read' or new.read_at is null then return new; end if;
  select * into parent from public.messages where id=new.message_id for update;
  if not found or parent.retention_after_read_seconds is null or parent.retention_started_at is not null then return new; end if;
  if not exists(select 1 from public.message_recipient_states where message_id=parent.id and state<>'blocked')
    or exists(select 1 from public.message_recipient_states where message_id=parent.id
      and state<>'blocked' and (state<>'read' or read_at is null)) then return new; end if;
  update public.messages set retention_started_at=clock_timestamp(),
    expires_at=clock_timestamp()+make_interval(secs=>parent.retention_after_read_seconds)
    where id=parent.id;
  -- Ne pas verrouiller les inbox d'autres appareils pendant leur ACK :
  -- leur lecture RPC applique l'échéance du parent sans inversion de verrous.
  return new;
end $$;
revoke all on function aegis_retention.start_after_read() from public,anon,authenticated;
create trigger aegis_start_retention_after_read after insert or update of state,read_at
on public.message_recipient_states for each row execute function aegis_retention.start_after_read();

create function aegis_retention.record_expiration() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old.retention_after_read_seconds is null or old.expires_at is null or old.expires_at>clock_timestamp() then return old; end if;
  delete from public.message_read_receipts where message_id=old.id;
  insert into public.message_expiration_tombstones(user_id,message_id,conversation_id,expired_at)
    select user_id,old.id,old.conversation_id,old.expires_at from public.conversation_participants
      where conversation_id=old.conversation_id
    union select old.sender_id,old.id,old.conversation_id,old.expires_at
    union select recipient_user_id,old.id,old.conversation_id,old.expires_at from public.message_recipient_states
      where message_id=old.id
    on conflict do nothing;
  return old;
end $$;
revoke all on function aegis_retention.record_expiration() from public,anon,authenticated;
create trigger aegis_record_expiration before delete on public.messages
for each row execute function aegis_retention.record_expiration();

-- Fin de transaction : ne pas supprimer au milieu de l'ACK et de ses reçus.
create function aegis_retention.expire_immediate() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  delete from public.messages where id=new.message_id and retention_after_read_seconds=0
    and retention_started_at is not null and expires_at<=clock_timestamp();
  return null;
end $$;
revoke all on function aegis_retention.expire_immediate() from public,anon,authenticated;
create constraint trigger aegis_expire_immediate after insert or update on public.message_recipient_states
deferrable initially deferred for each row execute function aegis_retention.expire_immediate();

create function aegis_retention.purge_expired() returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare removed integer;
begin
  with expired as (select id from public.messages where retention_after_read_seconds is not null
    and expires_at<=clock_timestamp() order by expires_at limit 1000 for update skip locked)
  delete from public.messages using expired where messages.id=expired.id;
  get diagnostics removed=row_count;
  return removed;
end $$;
revoke all on function aegis_retention.purge_expired() from public,anon,authenticated;

-- Les lectures directes ne révèlent jamais un contenu expiré, même entre deux purges.
create policy messages_retention_visible on public.messages as restrictive for select to authenticated
  using (retention_after_read_seconds is null or expires_at is null or expires_at>clock_timestamp());
create policy archives_retention_visible on public.message_archives as restrictive for select to authenticated
  using (exists(select 1 from public.messages m where m.id=message_archives.message_id));
create policy copies_retention_visible on public.message_device_copies as restrictive for select to authenticated
  using (exists(select 1 from public.messages m where m.id=message_device_copies.message_id));

create or replace function public.get_device_copies_for_messages(p_message_ids uuid[],p_device_id text)
returns table(message_id uuid,encrypted_body text,sender_user_id uuid,sender_device_id text,recipient_device_id text,created_at timestamptz)
language sql stable security definer set search_path=public,pg_temp as $$
  select copy.message_id,copy.encrypted_body,copy.sender_user_id,copy.sender_device_id,copy.recipient_device_id,copy.created_at
  from public.message_device_copies copy join public.messages message on message.id=copy.message_id
  where copy.message_id=any(coalesce(p_message_ids,array[]::uuid[]))
    and copy.recipient_user_id=auth.uid() and copy.recipient_device_id=trim(p_device_id)
    and message.sender_id=copy.sender_user_id
    and (message.retention_after_read_seconds is null or message.expires_at is null or message.expires_at>clock_timestamp())
  order by copy.created_at,copy.message_id;
$$;
revoke all on function public.get_device_copies_for_messages(uuid[],text) from public,anon;
grant execute on function public.get_device_copies_for_messages(uuid[],text) to authenticated;

-- Les capsules d'un appareil hors ligne suivent la même échéance serveur.
-- Conserver le corps et les contrôles d'appareil du RPC réellement déployé.
do $$
declare
  definition text:=pg_get_functiondef('public.aegis_sync_device(text,integer)'::regprocedure);
  needle text:='and inbox.expires_at > now()';
  guard text:='and inbox.expires_at > now() and exists (select 1 from public.messages retention_parent where retention_parent.id=inbox.message_id and (retention_parent.retention_after_read_seconds is null or retention_parent.expires_at is null or retention_parent.expires_at>clock_timestamp()))';
begin
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'RETENTION_INBOX_DEFINITION_UNEXPECTED';
  end if;
  execute replace(definition,needle,guard);
end $$;
do $$ begin
  if exists(select 1 from pg_namespace where nspname='cron') then
    perform cron.schedule('aegis-message-retention','* * * * *','select aegis_retention.purge_expired();');
  end if;
end $$;
-- Le RPC des prévisualisations est SECURITY DEFINER : son filtre doit être
-- explicite, sinon il contourne la politique RLS des messages expirés.
do $$
declare
  definition text:=pg_get_functiondef('public.get_conversations_with_details(uuid)'::regprocedure);
  needle text:='from public.messages message';
  guard text:='from (select * from public.messages retention_parent where retention_parent.retention_after_read_seconds is null or retention_parent.expires_at is null or retention_parent.expires_at>clock_timestamp()) message';
begin
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'RETENTION_PREVIEW_DEFINITION_UNEXPECTED';
  end if;
  execute replace(definition,needle,guard);
end $$;
notify pgrst,'reload schema';
commit;
