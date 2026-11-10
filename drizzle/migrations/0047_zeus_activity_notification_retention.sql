alter table public.notifications add column archived_at timestamptz;
create index notifications_retention_active_idx on public.notifications(created_at,id) where archived_at is null;
create index notifications_retention_archived_idx on public.notifications(archived_at,id) where archived_at is not null;

-- La lecture et la purge partagent les mêmes échéances, sans supprimer de message privé.
create policy "Notification active retention" on public.notifications as restrictive for select to authenticated
using (archived_at is null and created_at > now() - case when read_at is null then interval '90 days' else interval '30 days' end);
create function public.guard_notification_archive() returns trigger language plpgsql set search_path='' as $$
begin
  if auth.role()='authenticated' and ((tg_op='INSERT' and new.archived_at is not null)
    or (tg_op='UPDATE' and new.archived_at is distinct from old.archived_at)) then
    raise exception 'NOTIFICATION_RETENTION_SERVER_ONLY';
  end if;
  return new;
end $$;
create trigger guard_notification_archive before insert or update on public.notifications
for each row execute function public.guard_notification_archive();

create function public.zeus_activity_summary() returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare viewer uuid:=auth.uid(); messages_count bigint; notifications_count bigint; replies_count bigint; friends_count bigint; friend_preview jsonb;
begin
  if viewer is null then raise exception 'NOT_AUTHENTICATED' using errcode='42501'; end if;
  select coalesce(sum(c.unread_count),0) into messages_count from public.get_conversations_with_details(viewer) c;
  select count(*), count(*) filter(where n.type='comment' and exists(
    select 1 from public.posts p where p.id=n.post_id and p.user_id=viewer))
    into notifications_count,replies_count from public.notifications n where n.user_id=viewer and n.read_at is null;
  select count(*) into friends_count from public.friendships f where f.addressee_id=viewer and f.status='pending';
  select coalesce(jsonb_agg(jsonb_build_object(
    'friendship_id',request.friendship_id,
    'requester_id',request.requester_id,
    'name',request.name,
    'avatar_url',request.avatar_url
  ) order by request.created_at desc),'[]'::jsonb) into friend_preview
  from (
    select f.id friendship_id,f.requester_id,p.name,p.avatar_url,f.created_at
    from public.friendships f
    join public.profiles p on p.user_id=f.requester_id
    where f.addressee_id=viewer and f.status='pending'
    order by f.created_at desc,f.id
    limit 5
  ) request;
  return jsonb_build_object('unread_messages',messages_count,'unread_notifications',notifications_count,
    'publication_replies',replies_count,'friend_requests',friends_count,
    'friend_requests_preview',friend_preview,'checked_at',now());
end $$;
revoke all on function public.zeus_activity_summary() from public,anon;
grant execute on function public.zeus_activity_summary() to authenticated;

create function public.zeus_respond_friend_request(p_friendship_id uuid,p_accept boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare viewer uuid:=auth.uid(); changed public.friendships%rowtype;
begin
  if viewer is null then raise exception 'NOT_AUTHENTICATED' using errcode='42501'; end if;
  if p_accept is null then raise exception 'INVALID_FRIEND_DECISION'; end if;
  update public.friendships f set status=(case when p_accept then 'accepted' else 'rejected' end)::public.friendship_status
  where f.id=p_friendship_id and f.addressee_id=viewer and f.status='pending'
  returning f.* into changed;
  if changed.id is null then raise exception 'FRIEND_REQUEST_NOT_PENDING' using errcode='P0002'; end if;
  if p_accept then
    insert into public.notifications(user_id,type,actor_id) values(changed.requester_id,'friend_accepted',viewer);
  end if;
  return jsonb_build_object('friendship_id',changed.id,'requester_id',changed.requester_id,
    'decision',case when p_accept then 'accepted' else 'rejected' end);
end $$;
revoke all on function public.zeus_respond_friend_request(uuid,boolean) from public,anon;
grant execute on function public.zeus_respond_friend_request(uuid,boolean) to authenticated;

create function public.zeus_find_contacts(p_name text) returns table(user_id uuid,name text,avatar_url text)
language sql stable security invoker set search_path='' as $$
  with wanted as(select regexp_replace(translate(lower(trim(p_name)),'àâäéèêëîïôöùûüÿç','aaaeeeeiioouuuyc'),'[^[:alnum:] ]',' ','g') as value)
  select p.user_id,p.name,p.avatar_url from public.profiles p cross join wanted w
  where auth.uid() is not null and p.user_id<>auth.uid() and length(p_name) between 1 and 120 and length(trim(w.value))>0
    and regexp_replace(translate(lower(p.name),'àâäéèêëîïôöùûüÿç','aaaeeeeiioouuuyc'),'[^[:alnum:] ]',' ','g') like '%'||w.value||'%'
  order by (translate(lower(p.name),'àâäéèêëîïôöùûüÿç','aaaeeeeiioouuuyc')=w.value) desc,p.name,p.user_id limit 21;
$$;
revoke all on function public.zeus_find_contacts(text) from public,anon;
grant execute on function public.zeus_find_contacts(text) to authenticated;

create function public.purge_old_notifications(p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare eligible bigint; removable bigint; archived bigint:=0; deleted bigint:=0;
begin
  select count(*) into eligible from public.notifications where archived_at is null
    and created_at <= now() - case when read_at is null then interval '90 days' else interval '30 days' end;
  select count(*) into removable from public.notifications where archived_at <= now()-interval '7 days';
  if not p_dry_run then
    with batch as(select id from public.notifications where archived_at is null
      and created_at <= now() - case when read_at is null then interval '90 days' else interval '30 days' end
      order by created_at,id limit 10000 for update skip locked)
    update public.notifications n set archived_at=now() from batch where n.id=batch.id;
    get diagnostics archived=row_count;
    with batch as(select id from public.notifications where archived_at <= now()-interval '7 days'
      order by archived_at,id limit 10000 for update skip locked)
    delete from public.notifications n using batch where n.id=batch.id;
    get diagnostics deleted=row_count;
  end if;
  return jsonb_build_object('dry_run',p_dry_run,'eligible_to_archive',eligible,'eligible_to_delete',removable,
    'archived',archived,'deleted',deleted);
end $$;
revoke all on function public.purge_old_notifications(boolean) from public,anon,authenticated;
grant execute on function public.purge_old_notifications(boolean) to service_role;
do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    if exists(select 1 from cron.job where jobname='notification-retention') then
      perform cron.unschedule('notification-retention');
    end if;
    perform cron.schedule('notification-retention','15 3 * * *','select public.purge_old_notifications(false)');
  else
    raise warning 'NOTIFICATION_RETENTION_SCHEDULER_UNAVAILABLE';
  end if;
end $$;