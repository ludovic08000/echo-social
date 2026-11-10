begin;
create schema if not exists zeus_private;
revoke all on schema zeus_private from public,anon;
grant usage on schema zeus_private to authenticated;

create table zeus_private.capability_policies (
  capability text primary key,
  enabled boolean not null default true,
  minimum_confirmation boolean not null,
  require_confirmation boolean not null,
  required_role public.app_role,
  paid_only boolean not null default false,
  revision bigint not null default 1,
  check(not minimum_confirmation or require_confirmation)
);
insert into zeus_private.capability_policies(capability,minimum_confirmation,require_confirmation) values
 ('activity.read',false,false),('messages.send',true,true),('calls.start',true,true),('posts.publish',true,true),
 ('friend_requests.list',false,false),('friend_requests.show_profile',false,false),('friend_requests.respond',true,true),
 ('feed.preferences.update',true,true),('appearance.feed.update',true,true);
create table zeus_private.policy_audit (
  id bigint generated always as identity primary key,at timestamptz not null default now(),actor_id uuid not null,
  capability text not null,previous_policy jsonb not null,next_policy jsonb not null
);
create table zeus_private.command_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,command_key text not null check(length(command_key) between 1 and 160),
  capability text not null references zeus_private.capability_policies(capability),
  fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  prepared_at timestamptz not null,claimed_at timestamptz not null default now(),
  result jsonb,primary key(user_id,command_key)
);
create index zeus_command_retention_idx on zeus_private.command_receipts(claimed_at);
create index zeus_command_actor_time_idx on zeus_private.command_receipts(user_id,claimed_at);
alter table zeus_private.capability_policies enable row level security;
alter table zeus_private.policy_audit enable row level security;
alter table zeus_private.command_receipts enable row level security;
revoke all on all tables in schema zeus_private from public,anon,authenticated;

create function zeus_private.capability_state(p_capability text,p_from_voice boolean default false) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare viewer uuid:=auth.uid(); rule zeus_private.capability_policies%rowtype; allowed boolean;
begin
  select * into rule from zeus_private.capability_policies where capability=p_capability;
  if not found then raise exception 'ZEUS_UNKNOWN_CAPABILITY' using errcode='22023'; end if;
  allowed:=viewer is not null and rule.enabled;
  if allowed and rule.required_role is not null then
    allowed:=coalesce(public.has_role(viewer,rule.required_role),false);
  end if;
  if allowed and rule.paid_only then
    allowed:=exists(select 1 from public.creator_subscriptions where user_id=viewer and status='active'
      and plan in ('creator_essential','creator_pro','creator_studio') and stripe_subscription_id is not null and current_period_end>now());
  end if;
  if allowed and coalesce(p_from_voice,false) then allowed:=coalesce(public.voice_command_access(),false); end if;
  return jsonb_build_object('allowed',allowed,'requires_confirmation',rule.require_confirmation,'revision',rule.revision,'checked_at',now());
end $$;
create function public.zeus_capability_state(p_capability text,p_from_voice boolean default false) returns jsonb
language sql stable security invoker set search_path='' as $$select zeus_private.capability_state(p_capability,p_from_voice)$$;

create function zeus_private.claim_command(p_key text,p_capability text,p_fingerprint text,p_prepared_at timestamptz,p_from_voice boolean,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare viewer uuid:=auth.uid(); rule jsonb; existing zeus_private.command_receipts%rowtype;
begin
  rule:=zeus_private.capability_state(p_capability,p_from_voice);
  if not coalesce((rule->>'allowed')::boolean,false) then raise exception 'ZEUS_CAPABILITY_DENIED' using errcode='42501'; end if;
  if coalesce((rule->>'requires_confirmation')::boolean,false) and not coalesce(p_confirmed,false) then
    raise exception 'ZEUS_CONFIRMATION_REQUIRED' using errcode='42501';
  end if;
  if p_prepared_at is null or p_prepared_at<now()-interval '5 minutes' or p_prepared_at>now()+interval '30 seconds' then
    raise exception 'ZEUS_PROPOSAL_EXPIRED' using errcode='22023';
  end if;
  if p_capability not in ('messages.send','calls.start','posts.publish','friend_requests.respond','feed.preferences.update','appearance.feed.update') then
    raise exception 'ZEUS_INVALID_CLAIM';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('zeus-command:'||viewer::text,0));
  select * into existing from zeus_private.command_receipts where user_id=viewer and command_key=p_key for update;
  if found then
    if existing.capability<>p_capability or existing.fingerprint<>p_fingerprint then raise exception 'ZEUS_COMMAND_CHANGED' using errcode='22023'; end if;
    return jsonb_build_object('claimed',false,'result',existing.result);
  end if;
  if (select count(*) from zeus_private.command_receipts where user_id=viewer and claimed_at>now()-interval '1 minute')>=60
    or (select count(*) from zeus_private.command_receipts where user_id=viewer and claimed_at>now()-interval '1 day')>=2000 then
    raise exception 'ZEUS_COMMAND_RATE_LIMIT' using errcode='54000';
  end if;
  insert into zeus_private.command_receipts(user_id,command_key,capability,fingerprint,prepared_at)
  values(viewer,p_key,p_capability,p_fingerprint,p_prepared_at) on conflict(user_id,command_key) do nothing;
  if found then return jsonb_build_object('claimed',true); end if;
  select * into existing from zeus_private.command_receipts where user_id=viewer and command_key=p_key for update;
  if existing.capability<>p_capability or existing.fingerprint<>p_fingerprint then
    raise exception 'ZEUS_COMMAND_CHANGED' using errcode='22023';
  end if;
  return jsonb_build_object('claimed',false,'result',existing.result);
end $$;
create function public.zeus_claim_command(p_key text,p_capability text,p_fingerprint text,p_prepared_at timestamptz,p_from_voice boolean default false,p_confirmed boolean default false)
returns jsonb language sql security invoker set search_path='' as $$
 select zeus_private.claim_command(p_key,p_capability,p_fingerprint,p_prepared_at,p_from_voice,p_confirmed)
$$;

-- Les données restent lues avec RLS ; les fonctions internes ne sont pas exposées par PostgREST.
alter function public.zeus_activity_summary() set schema zeus_private;
create function public.zeus_activity_summary() returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
  if not coalesce((zeus_private.capability_state('activity.read')->>'allowed')::boolean,false) then raise exception 'ZEUS_CAPABILITY_DENIED' using errcode='42501'; end if;
  return zeus_private.zeus_activity_summary();
end $$;
alter function public.zeus_respond_friend_request(uuid,boolean) set schema zeus_private;
create function public.zeus_respond_friend_request(p_friendship_id uuid,p_accept boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  if not coalesce((zeus_private.capability_state('friend_requests.respond')->>'allowed')::boolean,false) then raise exception 'ZEUS_CAPABILITY_DENIED' using errcode='42501'; end if;
  if p_accept is null then raise exception 'INVALID_FRIEND_DECISION'; end if;
  return zeus_private.zeus_respond_friend_request(p_friendship_id,p_accept);
end $$;
create function public.zeus_pending_friend_requests(p_name text default null) returns table(friendship_id uuid,requester_id uuid,name text,avatar_url text)
language plpgsql stable security invoker set search_path='' as $$
begin
  if not coalesce((zeus_private.capability_state('friend_requests.list')->>'allowed')::boolean,false) then raise exception 'ZEUS_CAPABILITY_DENIED' using errcode='42501'; end if;
  if length(coalesce(p_name,''))>120 then raise exception 'INVALID_PERSON_NAME'; end if;
  return query select f.id,f.requester_id,coalesce(nullif(trim(p.name),''),'Utilisateur'),p.avatar_url
  from public.friendships f join public.profiles p on p.user_id=f.requester_id
  where f.addressee_id=auth.uid() and f.status='pending' and (p_name is null or
    regexp_replace(translate(lower(p.name),'àâäéèêëîïôöùûüÿç','aaaeeeeiioouuuyc'),'[^[:alnum:] ]',' ','g') like '%'||
      regexp_replace(translate(lower(trim(p_name)),'àâäéèêëîïôöùûüÿç','aaaeeeeiioouuuyc'),'[^[:alnum:] ]',' ','g')||'%')
  order by f.created_at desc,f.id limit 51;
end $$;

create function zeus_private.execute_personal(p_key text,p_action jsonb,p_prepared_at timestamptz,p_from_voice boolean,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cap text; fingerprint text; claim jsonb; receipt jsonb; change uuid; target uuid; decision boolean;
begin
  if p_action->>'type'='respond_friend_request' then cap:='friend_requests.respond';
  elsif p_action->>'type'='update_feed_config' then cap:='feed.preferences.update';
  else raise exception 'ZEUS_INVALID_PERSONAL_ACTION'; end if;
  -- Le payload de ces deux actions ne contient ni message privé ni clé.
  fingerprint:=encode(sha256(convert_to(p_action::text,'UTF8')),'hex');
  claim:=zeus_private.claim_command(p_key,cap,fingerprint,p_prepared_at,p_from_voice,p_confirmed);
  if not (claim->>'claimed')::boolean then
    if claim->'result' is null or claim->'result'='null'::jsonb then raise exception 'ZEUS_COMMAND_ALREADY_CLAIMED'; end if;
    return claim->'result';
  end if;
  if cap='friend_requests.respond' then
    if p_action->>'decision' not in ('accept','reject') or p_action->>'decision' is null then raise exception 'INVALID_FRIEND_DECISION'; end if;
    target:=(p_action->>'friendship_id')::uuid;decision:=p_action->>'decision'='accept';
    receipt:=public.zeus_respond_friend_request(target,decision);
  else
    select change_id into change from public.apply_feed_preference_command(p_action->>'summary',p_action->'command');
    if change is null then raise exception 'FEED_CHANGE_NOT_APPLIED'; end if;
    receipt:=jsonb_build_object('change_id',change);
  end if;
  update zeus_private.command_receipts set result=receipt where user_id=auth.uid() and command_key=p_key;
  return receipt;
end $$;
create function public.zeus_execute_personal_command(p_key text,p_action jsonb,p_prepared_at timestamptz,p_from_voice boolean default false,p_confirmed boolean default false)
returns jsonb language sql security invoker set search_path='' as $$
 select zeus_private.execute_personal(p_key,p_action,p_prepared_at,p_from_voice,p_confirmed)
$$;

create function zeus_private.policies() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not coalesce(public.has_role(auth.uid(),'admin'::public.app_role),false) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  return (select jsonb_agg(to_jsonb(p) order by capability) from zeus_private.capability_policies p);
end $$;
create function public.zeus_capability_policies() returns jsonb language sql stable security invoker set search_path='' as $$select zeus_private.policies()$$;
create function zeus_private.set_policy(p_capability text,p_enabled boolean,p_required_role public.app_role,p_paid_only boolean,p_confirmation boolean,p_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous zeus_private.capability_policies%rowtype; changed zeus_private.capability_policies%rowtype;
begin
  if auth.uid() is null or not coalesce(public.has_role(auth.uid(),'admin'::public.app_role),false) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  select * into previous from zeus_private.capability_policies where capability=p_capability for update;
  if not found or previous.revision<>p_revision then raise exception 'ZEUS_POLICY_CHANGED'; end if;
  update zeus_private.capability_policies set enabled=p_enabled,required_role=p_required_role,paid_only=p_paid_only,
    require_confirmation=p_confirmation,revision=revision+1 where capability=p_capability returning * into changed;
  insert into zeus_private.policy_audit(actor_id,capability,previous_policy,next_policy) values(auth.uid(),p_capability,to_jsonb(previous),to_jsonb(changed));
  return to_jsonb(changed);
end $$;
create function public.zeus_set_capability_policy(p_capability text,p_enabled boolean,p_required_role public.app_role,p_paid_only boolean,p_confirmation boolean,p_revision bigint)
returns jsonb language sql security invoker set search_path='' as $$select zeus_private.set_policy(p_capability,p_enabled,p_required_role,p_paid_only,p_confirmation,p_revision)$$;

revoke all on all functions in schema zeus_private from public,anon;
grant execute on all functions in schema zeus_private to authenticated;
revoke all on function public.zeus_capability_state(text,boolean),public.zeus_claim_command(text,text,text,timestamptz,boolean,boolean),
 public.zeus_activity_summary(),public.zeus_respond_friend_request(uuid,boolean),public.zeus_pending_friend_requests(text),
 public.zeus_execute_personal_command(text,jsonb,timestamptz,boolean,boolean),public.zeus_capability_policies(),
 public.zeus_set_capability_policy(text,boolean,public.app_role,boolean,boolean,bigint) from public,anon;
grant execute on function public.zeus_capability_state(text,boolean),public.zeus_claim_command(text,text,text,timestamptz,boolean,boolean),
 public.zeus_activity_summary(),public.zeus_respond_friend_request(uuid,boolean),public.zeus_pending_friend_requests(text),
 public.zeus_execute_personal_command(text,jsonb,timestamptz,boolean,boolean),public.zeus_capability_policies(),
 public.zeus_set_capability_policy(text,boolean,public.app_role,boolean,boolean,bigint) to authenticated;
create function zeus_private.dispatch_post(p_key text,p_fingerprint text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if not coalesce((zeus_private.capability_state('posts.publish')->>'allowed')::boolean,false) then raise exception 'ZEUS_CAPABILITY_DENIED' using errcode='42501'; end if;
  update zeus_private.command_receipts set result=jsonb_build_object('dispatched',true)
  where user_id=auth.uid() and command_key=p_key and capability='posts.publish' and fingerprint=p_fingerprint
    and result is null and claimed_at>now()-interval '5 minutes';
  return found;
end $$;
create function public.zeus_dispatch_post_command(p_key text,p_fingerprint text) returns boolean
language sql security invoker set search_path='' as $$select zeus_private.dispatch_post(p_key,p_fingerprint)$$;
revoke all on function zeus_private.dispatch_post(text,text),public.zeus_dispatch_post_command(text,text) from public,anon;
grant execute on function zeus_private.dispatch_post(text,text),public.zeus_dispatch_post_command(text,text) to authenticated;

create function zeus_private.purge_receipts() returns bigint language plpgsql security definer set search_path='' as $$
declare removed bigint;
begin
  with batch as(select user_id,command_key from zeus_private.command_receipts where claimed_at<now()-interval '30 days'
    order by claimed_at limit 10000 for update skip locked)
  delete from zeus_private.command_receipts r using batch b where r.user_id=b.user_id and r.command_key=b.command_key;
  get diagnostics removed=row_count; return removed;
end $$;
revoke all on function zeus_private.purge_receipts() from public,anon,authenticated;
grant usage on schema zeus_private to service_role;
grant execute on function zeus_private.purge_receipts() to service_role;
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('zeus-command-retention','35 3 * * *','select zeus_private.purge_receipts()');
  else raise warning 'ZEUS_COMMAND_RETENTION_SCHEDULER_UNAVAILABLE'; end if;
end $$;
commit;
