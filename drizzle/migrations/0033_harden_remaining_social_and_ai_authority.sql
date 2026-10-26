
-- La capacité est vérifiée sur les vraies relations, sous verrous ordonnés des deux comptes.
create function public.enforce_friendship_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_user uuid;v_actor uuid:=(select auth.uid());
begin
  if new.status<>'accepted' or (tg_op='UPDATE' and old.status='accepted') then return new; end if;
  if v_actor is not null and v_actor not in(new.requester_id,new.addressee_id) then
    raise exception 'FORBIDDEN' using errcode='42501';end if;
  if v_actor is null and coalesce(current_setting('role',true),'')<>'service_role'
    and session_user not in ('postgres','supabase_admin') then
    raise exception 'NOT_AUTHENTICATED' using errcode='42501'; end if;
  for v_user in select distinct id from unnest(array[new.requester_id,new.addressee_id]) as ids(id) order by id loop
    perform pg_advisory_xact_lock(hashtextextended(v_user::text,182026));
  end loop;
  foreach v_user in array array[new.requester_id,new.addressee_id] loop
    if (select count(*) from public.friendships f where f.status='accepted'
      and v_user in(f.requester_id,f.addressee_id) and f.id<>new.id)>=5000 then
      raise exception 'FRIEND_LIMIT_REACHED' using errcode='23514'; end if;
  end loop;
  return new;
end $$;
revoke all on function public.enforce_friendship_capacity() from public,anon,authenticated;
create trigger enforce_friendship_capacity before insert or update on public.friendships
  for each row execute function public.enforce_friendship_capacity();

create table public.ai_usage_reservations(
  request_id uuid primary key,user_id uuid not null,agent_id uuid not null references public.ai_agents(id) on delete cascade,
  usage_date date not null,state text not null default 'reserved' check(state in('reserved','committed','released')),
  created_at timestamptz not null default now()
);
alter table public.ai_usage_reservations enable row level security;
revoke all on public.ai_usage_reservations from public,anon,authenticated;
grant select,insert,update,delete on public.ai_usage_reservations to service_role;

create function public.reserve_ai_agent_usage(p_user_id uuid,p_agent_id uuid,p_request_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_limit integer;v_subscribed boolean;v_claim uuid;v_count integer;v_existing public.ai_usage_reservations%rowtype;
  v_day date:=timezone('utc',now())::date;
begin
  if p_user_id is null or p_agent_id is null or p_request_id is null then raise exception 'INVALID_USAGE_REQUEST';end if;
  select free_messages_per_day into v_limit from public.ai_agents where id=p_agent_id and is_active=true;
  if not found or v_limit is null or v_limit<0 then raise exception 'INVALID_AGENT_QUOTA';end if;
  select exists(select 1 from public.creator_subscriptions where user_id=p_user_id and status='active'
    and current_period_end>now()) into v_subscribed;
  insert into public.ai_usage_reservations(request_id,user_id,agent_id,usage_date)
    values(p_request_id,p_user_id,p_agent_id,v_day) on conflict(request_id) do nothing returning request_id into v_claim;
  if v_claim is null then
    select * into v_existing from public.ai_usage_reservations where request_id=p_request_id for update;
    if v_existing.user_id is distinct from p_user_id or v_existing.agent_id is distinct from p_agent_id then
      raise exception 'USAGE_REQUEST_BINDING_MISMATCH' using errcode='42501';end if;
    return jsonb_build_object('allowed',v_existing.state in('reserved','committed'),'limit',v_limit,'subscribed',v_subscribed);
  end if;
  if v_limit=0 and not v_subscribed then
    delete from public.ai_usage_reservations where request_id=p_request_id;
    return jsonb_build_object('allowed',false,'limit',v_limit,'subscribed',false);
  end if;
  insert into public.ai_agent_usage(user_id,agent_id,usage_date,message_count) values(p_user_id,p_agent_id,v_day,1)
    on conflict(user_id,agent_id,usage_date) do update
      set message_count=least(greatest(public.ai_agent_usage.message_count,0)::bigint+1,2147483647)::integer
      where v_subscribed or greatest(public.ai_agent_usage.message_count,0)<v_limit
    returning message_count into v_count;
  if v_count is null then
    delete from public.ai_usage_reservations where request_id=p_request_id;
    return jsonb_build_object('allowed',false,'limit',v_limit,'subscribed',v_subscribed);
  end if;
  return jsonb_build_object('allowed',true,'limit',v_limit,'message_count',v_count,'subscribed',v_subscribed);
end $$;

create function public.finish_ai_agent_usage(p_request_id uuid,p_success boolean) returns boolean
language plpgsql security invoker set search_path='' as $$
declare v_row public.ai_usage_reservations%rowtype;
begin
  if p_success is null then raise exception 'INVALID_USAGE_DECISION';end if;
  select * into v_row from public.ai_usage_reservations where request_id=p_request_id for update;
  if not found then raise exception 'UNKNOWN_USAGE_REQUEST';end if;
  if v_row.state<>'reserved' then return (v_row.state='committed' and p_success) or (v_row.state='released' and not p_success);end if;
  if not p_success then
    update public.ai_agent_usage set message_count=greatest(0,message_count-1)
      where user_id=v_row.user_id and agent_id=v_row.agent_id and usage_date=v_row.usage_date;
  end if;
  update public.ai_usage_reservations set state=case when p_success then 'committed' else 'released' end
    where request_id=p_request_id;
  return true;
end $$;
revoke all on function public.reserve_ai_agent_usage(uuid,uuid,uuid),public.finish_ai_agent_usage(uuid,boolean) from public,anon,authenticated;
grant execute on function public.reserve_ai_agent_usage(uuid,uuid,uuid),public.finish_ai_agent_usage(uuid,boolean) to service_role;

-- Les déclarations historiques du navigateur ne constituent pas une preuve d'échec Auth.
alter table public.login_attempts add column authority text not null default 'legacy_client';
create or replace function public.record_login_attempt(p_ip text,p_email_hash text,p_success boolean,p_user_agent text default null)
returns void language sql security invoker set search_path='' as $$
  insert into public.login_attempts(ip_address,email_hash,success,user_agent,authority)
    values(p_ip,p_email_hash,p_success,p_user_agent,'server_verified');
$$;
revoke all on function public.record_login_attempt(text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.record_login_attempt(text,text,boolean,text) to service_role;
grant insert on public.login_attempts to service_role;
CREATE OR REPLACE FUNCTION public.check_login_rate_limit(
  p_ip text,
  p_email_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_ip_failures int := 0;
  v_email_failures int := 0;
  v_recent_email_failures int := 0;
  v_retry int := 0;
BEGIN
  IF p_ip IS NULL AND p_email_hash IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
  END IF;

  IF p_ip IS NOT NULL THEN
    SELECT count(*) INTO v_ip_failures
    FROM public.login_attempts
    WHERE ip_address = p_ip
      AND authority = 'server_verified'
      AND success = false
      AND created_at > now() - interval '15 minutes';
  END IF;

  IF p_email_hash IS NOT NULL THEN
    SELECT count(*) INTO v_email_failures
    FROM public.login_attempts
    WHERE email_hash = p_email_hash
      AND authority = 'server_verified'
      AND success = false
      AND created_at > now() - interval '15 minutes';

    SELECT count(*) INTO v_recent_email_failures
    FROM public.login_attempts
    WHERE email_hash = p_email_hash
      AND authority = 'server_verified'
      AND success = false
      AND created_at > now() - interval '5 minutes';
  END IF;

  -- Hard blocks
  IF v_ip_failures >= 20 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', 900,
      'reason', 'ip_rate_limit'
    );
  END IF;

  IF v_email_failures >= 8 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', 900,
      'reason', 'email_rate_limit'
    );
  END IF;

  -- Progressive backoff after 3 recent failures on the same email
  IF v_recent_email_failures >= 3 THEN
    -- 2^(failures-2) seconds, capped at 60s
    v_retry := LEAST(60, power(2, v_recent_email_failures - 2)::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', v_retry,
      'reason', 'backoff'
    );
  END IF;

  RETURN jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
END;
$$;

revoke all on function public.check_login_rate_limit(text,text) from public,anon,authenticated;
grant execute on function public.check_login_rate_limit(text,text) to service_role;
grant select on public.login_attempts to service_role;
CREATE OR REPLACE FUNCTION public.claim_feed_feature_jobs(p_limit integer DEFAULT 40)
RETURNS TABLE(post_id uuid, revision uuid, body text, image_url text, user_id uuid,
  created_at timestamptz, likes_count integer, comments_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT j.post_id FROM public.feed_feature_jobs j
    JOIN public.posts p ON p.id=j.post_id
    JOIN public.privacy_settings privacy ON privacy.user_id=p.user_id
    WHERE (j.status IN ('pending','failed') OR (j.status='working' AND j.lease_until < now()))
      AND j.available_at <= now() AND j.attempts < 8
      AND (p.publish_at IS NULL OR p.publish_at <= now())
      AND (p.expires_at IS NULL OR p.expires_at > now())
      AND NOT coalesce(p.subscriber_only,false) AND privacy.ai_data_sharing_enabled = true AND privacy.ai_personalization_enabled = true
      AND privacy.posts_visibility='public' AND privacy.profile_visibility='public'
    ORDER BY j.available_at, j.post_id FOR UPDATE OF j SKIP LOCKED
    LIMIT LEAST(60,GREATEST(1,p_limit))
  ), claimed AS (
    UPDATE public.feed_feature_jobs j SET status='working',attempts=j.attempts+1,revision=gen_random_uuid(),
      lease_until=now()+interval '5 minutes',updated_at=now()
    FROM candidates c WHERE j.post_id=c.post_id RETURNING j.post_id,j.revision
  )
  SELECT p.id,c.revision,p.body,p.image_url,p.user_id,p.created_at,p.likes_count,p.comments_count
    FROM claimed c JOIN public.posts p ON p.id=c.post_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_feed_feature_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_feed_feature_jobs(integer) TO service_role;


CREATE OR REPLACE FUNCTION public.finish_feed_feature_job(p_post uuid,p_revision uuid,p_features jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  job public.feed_feature_jobs%ROWTYPE;
  semantic_vector public.ml_post_features.embedding%TYPE;
BEGIN
  SELECT * INTO job FROM public.feed_feature_jobs j WHERE j.post_id=p_post FOR UPDATE;
  IF NOT FOUND OR job.revision<>p_revision OR job.status<>'working' OR job.lease_until < now() THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.posts p JOIN public.privacy_settings s ON s.user_id=p.user_id
    WHERE p.id=p_post AND NOT coalesce(p.subscriber_only,false) AND s.ai_data_sharing_enabled=true AND s.ai_personalization_enabled=true
      AND s.posts_visibility='public' AND s.profile_visibility='public'
      AND (p.expires_at IS NULL OR p.expires_at > now())
      AND (p.publish_at IS NULL OR p.publish_at <= now())) THEN
    UPDATE public.feed_feature_jobs SET status='skipped',lease_until=NULL WHERE post_id=p_post;
    RETURN false;
  END IF;
  IF p_features IS NULL THEN
    UPDATE public.feed_feature_jobs SET status='failed',lease_until=NULL,
      available_at=now()+make_interval(mins=>LEAST(1440,power(2,job.attempts)::integer)),updated_at=now()
      WHERE post_id=p_post;
    RETURN false;
  END IF;
  semantic_vector := p_features->>'embedding';
  INSERT INTO public.ml_post_features(post_id,topics,hashtags,sentiment,quality_score,language,has_media,creator_id,
    embedding,embedding_text,embedding_source,embedding_updated_at,updated_at)
  SELECT p.id,ARRAY(SELECT jsonb_array_elements_text(p_features->'topics')),
    ARRAY(SELECT jsonb_array_elements_text(p_features->'hashtags')),
    (p_features->>'sentiment')::numeric,(p_features->>'quality')::numeric,p_features->>'language',
    p.image_url IS NOT NULL,p.user_id,semantic_vector,
    p_features->>'embedding_text',p_features->>'embedding_source',now(),now()
    FROM public.posts p WHERE p.id=p_post
  ON CONFLICT(post_id) DO UPDATE SET topics=EXCLUDED.topics,hashtags=EXCLUDED.hashtags,
    sentiment=EXCLUDED.sentiment,quality_score=EXCLUDED.quality_score,language=EXCLUDED.language,
    has_media=EXCLUDED.has_media,creator_id=EXCLUDED.creator_id,embedding=EXCLUDED.embedding,
    embedding_text=EXCLUDED.embedding_text,embedding_source=EXCLUDED.embedding_source,
    embedding_updated_at=EXCLUDED.embedding_updated_at,updated_at=now();
  UPDATE public.feed_feature_jobs SET status=CASE WHEN p_features->>'embedding' IS NULL THEN 'skipped' ELSE 'ready' END,
    lease_until=NULL,updated_at=now() WHERE post_id=p_post;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.finish_feed_feature_job(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_feed_feature_job(uuid,uuid,jsonb) TO service_role;
