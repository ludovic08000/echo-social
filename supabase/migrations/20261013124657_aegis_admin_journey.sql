begin;

create schema if not exists aegis_observability;
revoke all on schema aegis_observability from public, anon;
grant usage on schema aegis_observability to authenticated;
create table aegis_observability.journey_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default clock_timestamp(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid, device_ref text, message_id uuid,
  stage text not null, outcome text not null check(outcome in ('info','success','failure')),
  source text not null, evidence text not null check(evidence in ('server','client_report','transport_report')),
  error_code text, request_id uuid, duration_ms integer
);
alter table aegis_observability.journey_events enable row level security;
revoke all on aegis_observability.journey_events from public, anon, authenticated;
create index journey_user_time on aegis_observability.journey_events(user_id, occurred_at desc, id desc);
create index journey_time on aegis_observability.journey_events(occurred_at desc, id desc);
create index journey_session on aegis_observability.journey_events(session_id, occurred_at desc) where session_id is not null;
create unique index journey_request on aegis_observability.journey_events(request_id) where request_id is not null;

-- Le JWT attribue le compte, pas la véracité d'un rapport HTTP. Aucune décision
-- d'approbation/routage ne peut utiliser cette télémétrie déclarative.
create function aegis_observability.record_request(p_request_id uuid,p_rpc text,p_status integer,p_error_code text,p_duration_ms integer)
returns void language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); s uuid := public.current_login_security_session_id(); c text;
begin
  if u is null or not exists(select 1 from auth.sessions x where x.id = s and x.user_id = u) then return; end if;
  if p_request_id is null or p_rpc is null or p_status is null or p_rpc not in ('aegis_send_message','aegis_sync_device','aegis_ack_device_messages') or p_status not between 200 and 599 then return; end if;
  -- Borne les rapports falsifiables par un client authentifié : 120/min/compte.
  perform pg_advisory_xact_lock(hashtextextended(u::text,9812));
  if (select count(*) from aegis_observability.journey_events where user_id=u and source='aegis_gateway' and occurred_at > now()-interval '1 minute') >= 120 then return; end if;
  c := case when p_error_code in ('DEVICE_NOT_FOUND','AEGIS_PEER_DEVICE_UPDATE_REQUIRED','DEVICE_NOT_APPROVED','DEVICE_ROUTE_NOT_READY','E2EE_DEVICE_LIST_STALE','E2EE_NO_SECURE_TARGET','E2EE_PARTICIPANT_ROUTE_UNAVAILABLE','AEGIS_PARTIAL_DEVICE_FANOUT','UPSTREAM_TIMEOUT','UPSTREAM_UNAVAILABLE','AEGIS_ARCHIVE_REQUIRED','42501','PGRST301') then p_error_code else 'UNCLASSIFIED_ERROR' end;
  insert into aegis_observability.journey_events(user_id,session_id,stage,outcome,source,evidence,error_code,request_id,duration_ms)
  values(u,s,p_rpc,case when p_status >=400 then 'failure' else 'success' end,'aegis_gateway','transport_report',case when p_status>=400 then c else null end,p_request_id,greatest(0,least(coalesce(p_duration_ms,0),120000)))
  on conflict (request_id) where request_id is not null do nothing;
end;
$$;
revoke all on function aegis_observability.record_request(uuid,text,integer,text,integer) from public,anon;
grant execute on function aegis_observability.record_request(uuid,text,integer,text,integer) to authenticated;
create function public.record_aegis_request_event(p_request_id uuid,p_rpc text,p_status integer,p_error_code text default null,p_duration_ms integer default 0)
returns void language sql security invoker set search_path = '' as $$
  select aegis_observability.record_request(p_request_id,p_rpc,p_status,p_error_code,p_duration_ms);
$$;
revoke all on function public.record_aegis_request_event(uuid,text,integer,text,integer) from public,anon;
grant execute on function public.record_aegis_request_event(uuid,text,integer,text,integer) to authenticated;

-- Observation seule : ne copie jamais payload, signature, jeton, IP ni contenu.
create function aegis_observability.capture_journey() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(new); old_r jsonb;
  u uuid; s uuid; d text; m uuid; stage text; outcome text := 'info';
  evidence text := 'server'; code text;
begin
  if tg_op = 'UPDATE' then old_r := to_jsonb(old); end if;
  if tg_table_name = 'user_devices' then
    if tg_op = 'UPDATE' and (r->'approval_status', r->'binding_status', r->'routing_status', r->'is_active', r->'revoked_at')
      is not distinct from (old_r->'approval_status', old_r->'binding_status', old_r->'routing_status', old_r->'is_active', old_r->'revoked_at') then return new; end if;
    u := (r->>'user_id')::uuid;
    d := substr(md5(r->>'device_id'),1,12);
    stage := case when r->>'revoked_at' is not null or r->>'is_active' = 'false' then 'device_disabled'
      when r->>'routing_status' = 'ready' then 'device_route_ready'
      when r->>'binding_status' = 'bound' then 'device_bound'
      when r->>'approval_status' = 'approved' then 'device_approved' else 'device_registered' end;
    outcome := case when stage = 'device_disabled' then 'info' else 'success' end;
    s := public.current_login_security_session_id();
  elsif tg_table_name = 'device_enrollment_challenges' then
    if tg_op = 'UPDATE' and (r->'consumed_at',r->'cancelled_at') is not distinct from (old_r->'consumed_at',old_r->'cancelled_at') then return new; end if;
    u := (r->>'user_id')::uuid; d := substr(md5(r->>'device_id'),1,12);
    s := public.current_login_security_session_id();
    stage := case when r->>'cancelled_at' is not null then 'device_enrollment_cancelled'
      when r->>'consumed_at' is not null then 'device_enrollment_completed' else 'device_enrollment_started' end;
    outcome := case when stage = 'device_enrollment_cancelled' then 'failure' else 'success' end;
  elsif tg_table_name = 'login_security_events' then
    if r->>'event_type' not in ('login_decision','email_token_consume','login_device_binding','login_assessment','approval_email','approval_email_queued','approval_email_queue_failed') then return new; end if;
    u := (r->>'user_id')::uuid; s := (r->>'session_id')::uuid; stage := r->>'event_type'; outcome := r->>'outcome';
    if stage = 'login_decision' then stage := case when r->'detail'->>'decision' = 'approve' then 'login_approved' else 'login_denied' end; end if;
  elsif tg_table_name = 'email_send_log' then
    if r->>'template_name' <> 'login_security_approval' then return new; end if;
    if tg_op = 'UPDATE' and r->'status' is not distinct from old_r->'status' then return new; end if;
    -- Ne conserver ni message_id (contient une empreinte de jeton), ni adresse.
    s := (regexp_match(r->>'message_id', '^login-security:([0-9a-f-]{36}):[0-9a-f]{16}(:enqueue-failure)?$'))[1]::uuid;
    select ls.user_id into u from public.login_security_sessions ls where ls.session_id = s;
    stage := case r->>'status' when 'pending' then 'approval_email_recorded'
      when 'sent' then 'approval_email_provider_accepted' when 'bounced' then 'approval_email_bounced'
      when 'complained' then 'approval_email_complained' when 'rate_limited' then 'approval_email_rate_limited'
      when 'dlq' then 'approval_email_abandoned' else 'approval_email_failed' end;
    outcome := case when r->>'status' = 'sent' then 'success' when r->>'status' = 'pending' then 'info' else 'failure' end;
  elsif tg_table_name = 'messages' then
    u := (r->>'sender_id')::uuid; m := (r->>'id')::uuid;
    s := public.current_login_security_session_id(); stage := 'message_stored'; outcome := 'success';
  elsif tg_table_name = 'crypto_error_logs' then
    u := (r->>'user_id')::uuid; d := substr(md5(r->>'my_device_id'),1,12);
    stage := case when r->'metadata'->>'stage' in ('state_lookup','step.enrolling','step.approving','step.binding','step.preparing_keys','step.syncing_account') then 'client_' || (r->'metadata'->>'stage') else 'client_crypto_failure' end;
    outcome := 'failure'; evidence := 'client_report';
    code := case when r->>'error_code' in ('DEVICE_NOT_FOUND','AEGIS_PEER_DEVICE_UPDATE_REQUIRED','CRYPTO_NOT_READY','DEVICE_NOT_APPROVED','DEVICE_ROUTE_NOT_READY','AEGIS_ARCHIVE_REQUIRED','DEVICE_STATE_LOOKUP_FAILED') then r->>'error_code' else 'UNCLASSIFIED_ERROR' end;
    s := public.current_login_security_session_id();
  end if;
  if u is not null and stage is not null then
    insert into aegis_observability.journey_events(user_id,session_id,device_ref,message_id,stage,outcome,source,evidence,error_code)
    values(u,s,d,m,stage,outcome,tg_table_name,evidence,code);
  end if;
  return new;
exception when others then
  -- Un défaut du journal ne doit jamais bloquer un message ou une approbation.
  raise log 'AEGIS_JOURNEY_CAPTURE_FAILED source=% sqlstate=%', tg_table_name, sqlstate;
  return new;
end;
$$;
revoke all on function aegis_observability.capture_journey() from public, anon, authenticated;
create trigger aegis_journey_devices after insert or update on public.user_devices for each row execute function aegis_observability.capture_journey();
create trigger aegis_journey_enrollment after insert or update on public.device_enrollment_challenges for each row execute function aegis_observability.capture_journey();
create trigger aegis_journey_login after insert on public.login_security_events for each row execute function aegis_observability.capture_journey();
create trigger aegis_journey_email after insert or update on public.email_send_log for each row execute function aegis_observability.capture_journey();
create trigger aegis_journey_messages after insert on public.messages for each row execute function aegis_observability.capture_journey();
create trigger aegis_journey_errors after insert on public.crypto_error_logs for each row execute function aegis_observability.capture_journey();

create function aegis_observability.admin_journey(p_account text default null, p_before_id bigint default null, p_outcome text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target uuid; result jsonb;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'admin'::public.app_role)
    or not exists(select 1 from auth.sessions s where s.id = public.current_login_security_session_id() and s.user_id = auth.uid()) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if nullif(trim(p_account),'') is not null then
    select u.id into target from auth.users u where lower(u.email) = lower(trim(p_account)) or u.id::text = trim(p_account) limit 1;
    if target is null then return '[]'::jsonb; end if;
  end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.occurred_at desc,e.id::bigint desc),'[]'::jsonb) into result from (
    select id::text as id,occurred_at,user_id,session_id,device_ref,message_id,stage,outcome,source,evidence,error_code,request_id,duration_ms
    from aegis_observability.journey_events
    where occurred_at >= now() - interval '30 days' and (target is null or user_id = target)
      and (p_before_id is null or (occurred_at,id) < (select j.occurred_at,j.id from aegis_observability.journey_events j where j.id = p_before_id and (target is null or j.user_id = target)))
      and (p_outcome is null or outcome = p_outcome)
    order by occurred_at desc,id desc limit 100
  ) e;
  return result;
end;
$$;
revoke all on function aegis_observability.admin_journey(text,bigint,text) from public, anon;
grant execute on function aegis_observability.admin_journey(text,bigint,text) to authenticated;
create function public.admin_aegis_journey(p_account text default null,p_before_id bigint default null,p_outcome text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select aegis_observability.admin_journey(p_account,p_before_id,p_outcome);
$$;
revoke all on function public.admin_aegis_journey(text,bigint,text) from public, anon;
grant execute on function public.admin_aegis_journey(text,bigint,text) to authenticated;

-- Rétention automatique si le plan dispose de pg_cron ; aucune donnée historique inventée.
do $$ begin
  if exists(select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aegis-journey-retention','17 3 * * *',
      $job$delete from aegis_observability.journey_events where occurred_at < now() - interval '30 days'$job$);
  end if;
end $$;
commit;
