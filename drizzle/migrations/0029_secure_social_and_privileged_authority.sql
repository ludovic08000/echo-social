
-- Une relation n'est acceptée que par le destinataire ; les deux identités restent immuables.
drop policy if exists "Users can send friend requests" on public.friendships;
drop policy if exists "Users can update their friendships" on public.friendships;
-- Les noms historiques ne sont pas uniformes : retirer toutes les politiques d'écriture INSERT/UPDATE.
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='friendships'
    and cmd in ('INSERT','UPDATE','ALL') loop
    execute format('drop policy %I on public.friendships',p.policyname);
  end loop;
end $$;
create policy "Participants read their friendships" on public.friendships for select to authenticated
  using((select auth.uid()) in(requester_id,addressee_id));
create policy "Participants remove their friendships" on public.friendships for delete to authenticated
  using((select auth.uid()) in(requester_id,addressee_id));
create policy "Requester creates pending friendship" on public.friendships for insert to authenticated
  with check(requester_id=(select auth.uid()) and requester_id<>addressee_id and status='pending');
create policy "Recipient decides pending friendship" on public.friendships for update to authenticated
  using(addressee_id=(select auth.uid()) and status='pending')
  with check(addressee_id=(select auth.uid()) and status in ('accepted','rejected'));
create function public.guard_friendship_identity() returns trigger language plpgsql set search_path='' as $$
begin
  if new.id is distinct from old.id or new.requester_id is distinct from old.requester_id
    or new.addressee_id is distinct from old.addressee_id or new.created_at is distinct from old.created_at then
    raise exception 'FRIENDSHIP_IDENTITY_IMMUTABLE' using errcode='42501'; end if;
  return new;
end $$;
create trigger guard_friendship_identity before update on public.friendships
  for each row execute function public.guard_friendship_identity();
revoke all on function public.guard_friendship_identity() from public,anon,authenticated;

-- Les mesures et décisions globales ne sont pas des données utilisateur éditables.
revoke insert,update,delete on public.ai_moderation_cache,public.ai_learned_rules,public.ai_agent_usage
  from public,anon,authenticated;
create function public.guard_ad_moderation() returns trigger language plpgsql set search_path='' as $$
begin
  if current_user not in ('postgres','supabase_admin','service_role')
    and not coalesce(public.has_role((select auth.uid()),'admin'),false) then
    if (tg_op='INSERT' and (new.moderation_status<>'pending' or new.moderation_reason is not null))
      or (tg_op='UPDATE' and (new.moderation_status is distinct from old.moderation_status
        or new.moderation_reason is distinct from old.moderation_reason)) then
      raise exception 'AD_MODERATION_SERVER_ONLY' using errcode='42501'; end if;
    if tg_op='UPDATE' and (new.headline is distinct from old.headline
      or new.primary_text is distinct from old.primary_text or new.image_url is distinct from old.image_url
      or new.video_url is distinct from old.video_url or new.cta_url is distinct from old.cta_url) then
      new.moderation_status:='pending';new.moderation_reason:=null;
    end if;
  end if;
  return new;
end $$;
create trigger guard_ad_moderation before insert or update on public.ads
  for each row execute function public.guard_ad_moderation();
revoke all on function public.guard_ad_moderation() from public,anon,authenticated;

-- La décision de demande est liée au destinataire JWT dans un dialogue à deux, jamais à un ID choisi seul.
create function public.decide_direct_message_request(p_conversation_id uuid,p_accept boolean)
returns integer language plpgsql security definer set search_path='' as $$
declare v_user uuid:=(select auth.uid());v_peer uuid;v_count integer;v_changed integer;
begin
  if v_user is null or p_accept is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  perform public.assert_current_login_session_approved();
  perform 1 from public.conversations where id=p_conversation_id and coalesce(is_group,false)=false for update;
  if not found then raise exception 'DIRECT_CONVERSATION_REQUIRED' using errcode='42501'; end if;
  select count(*),min(user_id::text)::uuid into v_count,v_peer from public.conversation_participants
    where conversation_id=p_conversation_id and user_id<>v_user;
  if v_count<>1 or not exists(select 1 from public.conversation_participants
      where conversation_id=p_conversation_id and user_id=v_user)
    or (select count(*) from public.conversation_participants where conversation_id=p_conversation_id)<>2
    or exists(select 1 from public.user_message_blocks where
      (blocker_user_id=v_user and blocked_user_id=v_peer) or (blocker_user_id=v_peer and blocked_user_id=v_user))
  then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if not exists(select 1 from public.messages where conversation_id=p_conversation_id and sender_id=v_peer and status='pending') then
    raise exception 'NO_INCOMING_REQUEST' using errcode='42501'; end if;
  update public.messages set status=case when p_accept then 'delivered' else 'blocked' end
    where conversation_id=p_conversation_id and sender_id=v_peer and status='pending';
  get diagnostics v_changed=row_count;
  return v_changed;
end $$;
revoke all on function public.decide_direct_message_request(uuid,boolean) from public,anon;
grant execute on function public.decide_direct_message_request(uuid,boolean) to authenticated;
