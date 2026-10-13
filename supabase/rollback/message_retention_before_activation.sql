-- Retour arrière autorisé uniquement AVANT tout choix utilisateur.
-- Après activation, on doit honorer les délais déjà promis, pas ressusciter des messages.
begin;
set local lock_timeout='3s';
do $$ begin
  if exists(select 1 from public.conversations where disappearing_after_read)
    or exists(select 1 from public.messages where retention_after_read_seconds is not null)
    or exists(select 1 from public.message_expiration_tombstones) then
    raise exception 'RETENTION_ALREADY_ACTIVE_ROLLBACK_REFUSED';
  end if;
  if exists(select 1 from pg_namespace where nspname='cron') then
    perform cron.unschedule(jobid) from cron.job where jobname='aegis-message-retention';
  end if;
end $$;
do $$
declare definition text:=pg_get_functiondef('public.aegis_sync_device(text,integer)'::regprocedure);
  guard text:='and inbox.expires_at > now() and exists (select 1 from public.messages retention_parent where retention_parent.id=inbox.message_id and (retention_parent.retention_after_read_seconds is null or retention_parent.expires_at is null or retention_parent.expires_at>clock_timestamp()))';
begin
  if position(guard in definition)=0 then raise exception 'RETENTION_INBOX_DEFINITION_UNEXPECTED'; end if;
  execute replace(definition,guard,'and inbox.expires_at > now()');
end $$;
do $$
declare definition text:=pg_get_functiondef('public.get_conversations_with_details(uuid)'::regprocedure);
  guard text:='from (select * from public.messages retention_parent where retention_parent.retention_after_read_seconds is null or retention_parent.expires_at is null or retention_parent.expires_at>clock_timestamp()) message';
begin
  if position(guard in definition)=0 then raise exception 'RETENTION_PREVIEW_DEFINITION_UNEXPECTED'; end if;
  execute replace(definition,guard,'from public.messages message');
end $$;
create or replace function public.get_device_copies_for_messages(p_message_ids uuid[],p_device_id text)
returns table(message_id uuid,encrypted_body text,sender_user_id uuid,sender_device_id text,recipient_device_id text,created_at timestamptz)
language sql stable security definer set search_path=public,pg_temp as $$
  select copy.message_id,copy.encrypted_body,copy.sender_user_id,copy.sender_device_id,copy.recipient_device_id,copy.created_at
  from public.message_device_copies copy join public.messages message on message.id=copy.message_id
  where copy.message_id=any(coalesce(p_message_ids,array[]::uuid[]))
    and copy.recipient_user_id=auth.uid() and copy.recipient_device_id=trim(p_device_id)
    and message.sender_id=copy.sender_user_id order by copy.created_at,copy.message_id;
$$;
drop trigger aegis_start_retention_after_read on public.message_recipient_states;
drop trigger aegis_expire_immediate on public.message_recipient_states;
drop trigger aegis_protect_message_retention on public.messages;
drop trigger aegis_record_expiration on public.messages;
drop policy messages_retention_visible on public.messages;
drop policy archives_retention_visible on public.message_archives;
drop policy copies_retention_visible on public.message_device_copies;
drop function public.set_conversation_retention(uuid,integer);
drop function aegis_retention.set_policy(uuid,integer);
drop function aegis_retention.start_after_read();
drop function aegis_retention.expire_immediate();
drop function aegis_retention.record_expiration();
drop function aegis_retention.protect_message_policy();
drop function aegis_retention.purge_expired();
create or replace function public.set_message_expires_at() returns trigger
language plpgsql security definer set search_path=public as $$
declare ttl integer;
begin
  if new.expires_at is null then
    select disappearing_seconds into ttl from public.conversations where id=new.conversation_id;
    if ttl is not null and ttl>0 then new.expires_at:=now()+make_interval(secs=>ttl); end if;
  end if;
  return new;
end $$;
drop trigger trg_log_disappearing_change on public.conversations;
create trigger trg_log_disappearing_change after update of disappearing_seconds on public.conversations
for each row execute function public.log_disappearing_change();
alter table public.conversations drop constraint conversation_retention_duration_valid;
alter table public.conversations drop column disappearing_after_read;
alter table public.messages drop column retention_after_read_seconds,drop column retention_started_at;
drop table public.message_expiration_tombstones;
drop schema aegis_retention;
notify pgrst,'reload schema';
commit;
