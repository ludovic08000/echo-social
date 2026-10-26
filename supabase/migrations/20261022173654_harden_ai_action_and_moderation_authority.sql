begin;

create schema if not exists aegis_ai_authority;
revoke all on schema aegis_ai_authority from public,anon,authenticated;
grant usage on schema aegis_ai_authority to service_role;

-- Un reçu par contenu et révision : un retry n'ajoute ni sanction ni réponse système.
create table aegis_ai_authority.moderation_receipts(
  kind text not null check(kind in('post','comment')),
  content_id uuid not null,
  revision text not null,
  actor_id uuid not null,
  strike_count integer not null,
  escalated boolean not null,
  reply text not null,
  reason text not null,
  severity text not null,
  category text not null,
  created_at timestamptz not null default now(),
  primary key(kind,content_id,revision)
);
alter table aegis_ai_authority.moderation_receipts enable row level security;
revoke all on aegis_ai_authority.moderation_receipts from public,anon,authenticated;
grant select,insert on aegis_ai_authority.moderation_receipts to service_role;

create table aegis_ai_authority.feed_config_audit(
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  key text not null,
  previous_value jsonb not null,
  new_value jsonb not null,
  reason text not null,
  created_at timestamptz not null default now()
);
alter table aegis_ai_authority.feed_config_audit enable row level security;
revoke all on aegis_ai_authority.feed_config_audit from public,anon,authenticated;
grant select,insert on aegis_ai_authority.feed_config_audit to service_role;

-- Une étiquette « Zeus » ne peut pas être choisie ou déplacée par le navigateur.
create policy comments_client_no_system_insert on public.comments as restrictive for insert to authenticated,anon
  with check(is_zeus_reply=false and user_id is not null);
create policy comments_client_no_system_update on public.comments as restrictive for update to authenticated,anon
  using(is_zeus_reply=false) with check(is_zeus_reply=false);
create function public.guard_comment_authority() returns trigger
language plpgsql security invoker set search_path='' as $$
declare parent_post uuid;
begin
  if tg_op='UPDATE' and current_user in('authenticated','anon')
    and (new.id is distinct from old.id or new.user_id is distinct from old.user_id
      or new.post_id is distinct from old.post_id or new.parent_id is distinct from old.parent_id) then
    raise exception 'COMMENT_IDENTITY_IMMUTABLE' using errcode='42501';
  end if;
  if new.parent_id is not null and (tg_op='INSERT' or new.parent_id is distinct from old.parent_id or new.post_id is distinct from old.post_id) then
    select c.post_id into parent_post from public.comments c where c.id=new.parent_id;
    if not found or parent_post is distinct from new.post_id then
      raise exception 'COMMENT_PARENT_POST_MISMATCH' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_comment_authority() from public,anon,authenticated;
create trigger comments_authority_guard before insert or update on public.comments
  for each row execute function public.guard_comment_authority();

revoke insert,update,delete on public.content_strikes,public.comment_moderation_alerts from public,anon,authenticated;
grant update(acknowledged,acknowledged_at) on public.content_strikes to authenticated;
-- Les modérateurs gardent leur circuit de revue existant ; le client ne crée pas de preuve.
grant update(status,reviewed_by,reviewed_at) on public.comment_moderation_alerts to authenticated;

create function public.apply_owned_content_moderation(
  p_kind text,p_content uuid,p_actor uuid,p_expected_body text,
  p_reason text,p_severity text,p_category text,p_reply text,p_reasoning text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_post uuid;v_author uuid;v_body text;v_system boolean;v_revision text;v_count integer;
  v_escalated boolean;v_previous aegis_ai_authority.moderation_receipts%rowtype;
begin
  if p_actor is null or p_content is null or coalesce(p_kind,'') not in('post','comment')
    or p_expected_body is null or length(p_expected_body)>30000
    or coalesce(length(trim(p_reason)),0) not between 1 and 1000
    or coalesce(p_severity,'') not in('info','warning','critical')
    or coalesce(p_category,'') not in('inappropriate','scam','spam','hate_speech','harassment','threats','discrimination','insult')
    or coalesce(length(p_reply),0) not between 1 and 2000 or length(coalesce(p_reasoning,''))>2000 then
    raise exception 'MODERATION_INPUT_INVALID' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('forsure:owned-moderation:'||p_actor::text,0));
  -- Toujours verrouiller la publication avant son commentaire pour rester compatible
  -- avec les suppressions en cascade et revérifier le contenu après l'appel IA.
  if p_kind='comment' then
    select c.post_id into v_post from public.comments c where c.id=p_content;
    if not found then return jsonb_build_object('applied',false,'reason','CONTENT_UNAVAILABLE');end if;
    perform 1 from public.posts where id=v_post for key share;
    if not found then return jsonb_build_object('applied',false,'reason','CONTENT_UNAVAILABLE');end if;
    select c.user_id,c.body,c.is_zeus_reply into v_author,v_body,v_system from public.comments c
      where c.id=p_content and c.post_id=v_post for update;
  else
    v_post:=p_content;
    select p.user_id,p.body,false into v_author,v_body,v_system from public.posts p where p.id=p_content for update;
  end if;
  if not found or v_author is distinct from p_actor or v_system then
    return jsonb_build_object('applied',false,'reason','CONTENT_UNAVAILABLE');end if;
  if coalesce(v_body,'') is distinct from p_expected_body then
    return jsonb_build_object('applied',false,'reason','CONTENT_CHANGED');end if;
  v_revision:=encode(sha256(convert_to(p_actor::text||':'||v_post::text||':'||coalesce(v_body,''),'UTF8')),'hex');
  select * into v_previous from aegis_ai_authority.moderation_receipts
    where kind=p_kind and content_id=p_content and revision=v_revision;
  if found then return jsonb_build_object('applied',true,'replayed',true,'strike_count',v_previous.strike_count,
    'escalated',v_previous.escalated,'zeus_reply',v_previous.reply,'reason',v_previous.reason,'severity',v_previous.severity,'category',v_previous.category);end if;
  select count(*)::integer+1 into v_count from public.content_strikes where user_id=p_actor;
  v_escalated:=p_kind='comment' and (p_severity='critical' or v_count>=3);
  insert into public.content_strikes(user_id,post_id,reason,severity,zeus_message)
    values(p_actor,v_post,p_reason,p_severity,p_reply);
  if p_kind='comment' then
    insert into public.comments(post_id,parent_id,user_id,is_zeus_reply,body) values(v_post,p_content,null,true,p_reply);
    if v_escalated then
      insert into public.comment_moderation_alerts(user_id,comment_id,post_id,evidence_text,category,severity,ai_reasoning,strike_count,status)
        values(p_actor,p_content,v_post,v_body,p_category,p_severity,p_reasoning,v_count,'pending');
    end if;
  end if;
  insert into aegis_ai_authority.moderation_receipts(kind,content_id,revision,actor_id,strike_count,escalated,reply,reason,severity,category)
    values(p_kind,p_content,v_revision,p_actor,v_count,v_escalated,p_reply,p_reason,p_severity,p_category);
  return jsonb_build_object('applied',true,'replayed',false,'strike_count',v_count,'escalated',v_escalated,'zeus_reply',p_reply,'reason',p_reason,'severity',p_severity,'category',p_category);
end $$;
revoke all on function public.apply_owned_content_moderation(text,uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.apply_owned_content_moderation(text,uuid,uuid,text,text,text,text,text,text) to service_role;

create function public.apply_admin_feed_config_update(p_actor uuid,p_key text,p_updates jsonb,p_expected jsonb,p_reason text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_current jsonb;v_next jsonb;entry record;item jsonb;
begin
  perform 1 from public.user_roles where user_id=p_actor and role='admin' for share;
  if not found then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
  if coalesce(p_key,'') not in('scoring_weights','recency_tiers','time_of_day','velocity','marketplace_injection','anti_spam')
    or jsonb_typeof(p_updates) is distinct from 'object' or p_updates='{}'::jsonb or octet_length(p_updates::text)>10000
    or coalesce(length(trim(p_reason)),0) not between 1 and 1000 then
    raise exception 'FEED_UPDATE_INVALID' using errcode='22023';end if;
  select value into v_current from public.feed_algorithm_config where key=p_key for update;
  if not found then raise exception 'FEED_CONFIG_NOT_FOUND' using errcode='P0002';end if;
  if v_current is distinct from p_expected then return jsonb_build_object('applied',false,'reason','FEED_CONFIG_CHANGED');end if;
  for entry in select key,value from jsonb_each(p_updates) loop
    if entry.key in('__proto__','prototype','constructor') or not(v_current ? entry.key)
      or jsonb_typeof(entry.value) is distinct from jsonb_typeof(v_current->entry.key) then
      raise exception 'FEED_FIELD_INVALID' using errcode='22023';end if;
    if jsonb_typeof(entry.value)='number' then
      if abs((entry.value::text)::numeric)>1000000 then raise exception 'FEED_NUMBER_INVALID' using errcode='22023';end if;
    elsif p_key='marketplace_injection' and entry.key='positions' and jsonb_typeof(entry.value)='array' then
      if jsonb_array_length(entry.value)>30 then raise exception 'FEED_POSITIONS_INVALID' using errcode='22023';end if;
      for item in select value from jsonb_array_elements(entry.value) loop
        if jsonb_typeof(item)<>'number' or item::text !~ '^[0-9]+$' or (item::text)::numeric>1000 then
          raise exception 'FEED_POSITIONS_INVALID' using errcode='22023';end if;
      end loop;
    elsif jsonb_typeof(entry.value)<>'boolean' then raise exception 'FEED_VALUE_INVALID' using errcode='22023';
    end if;
  end loop;
  v_next:=v_current||p_updates;
  update public.feed_algorithm_config set value=v_next,updated_at=now(),updated_by=p_actor where key=p_key;
  insert into aegis_ai_authority.feed_config_audit(actor_id,key,previous_value,new_value,reason)
    values(p_actor,p_key,v_current,v_next,p_reason);
  return jsonb_build_object('applied',true,'key',p_key,'new_value',v_next);
end $$;
revoke all on function public.apply_admin_feed_config_update(uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.apply_admin_feed_config_update(uuid,text,jsonb,jsonb,text) to service_role;
commit;
