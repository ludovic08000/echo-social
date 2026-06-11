-- ForSure Security Monitor automation
-- Defensive-only SOC automation: scheduled scan + controlled auto-mitigation.
-- Requirements in Supabase dashboard:
--   1. Enable pg_cron extension.
--   2. Enable pg_net extension.
--   3. Store SUPABASE_SERVICE_ROLE_KEY in Vault as 'service_role_key'.
--      Do not hardcode service_role in SQL.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Optional audit table for automated mitigations.
create table if not exists public.security_auto_mitigations (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid,
  source_ip text,
  mitigation_type text not null,
  reason text not null,
  severity text,
  confidence_score numeric,
  autonomy_level integer,
  action_result jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.security_auto_mitigations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'security_auto_mitigations'
      and policyname = 'Admins can read security auto mitigations'
  ) then
    create policy "Admins can read security auto mitigations"
    on public.security_auto_mitigations
    for select
    using (public.has_role(auth.uid(), 'admin'));
  end if;
exception when undefined_function then
  -- If has_role() is not available in this project version, keep RLS enabled
  -- and rely on service_role/backend access until the admin policy helper exists.
  null;
end $$;

-- Controlled mitigation function.
-- It only handles high-confidence existing incidents; it does not generate attacks,
-- does not inspect secrets, and does not expose service_role.
create or replace function public.apply_security_auto_mitigations()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  applied_count integer := 0;
  skipped_count integer := 0;
  ban_minutes integer;
begin
  for rec in
    select id, incident_type, severity, source_ip, confidence_score, autonomy_level, raw_data
    from public.security_incidents
    where created_at >= now() - interval '30 minutes'
      and source_ip is not null
      and coalesce(status, 'detected') in ('detected', 'auto_blocked')
      and (
        autonomy_level >= 3
        or severity = 'critical'
        or coalesce(confidence_score, 0) >= 0.85
      )
    order by created_at desc
    limit 50
  loop
    if exists (
      select 1 from public.security_auto_mitigations
      where incident_id = rec.id
    ) then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    ban_minutes := case
      when rec.severity = 'critical' or rec.autonomy_level >= 3 then 60
      when coalesce(rec.confidence_score, 0) >= 0.9 then 30
      else 15
    end;

    -- Prefer updating ddos tracker because it is already the runtime shield input.
    update public.ddos_ip_tracker
    set
      penalty_level = greatest(coalesce(penalty_level, 0), case when ban_minutes >= 60 then 4 else 3 end),
      blocked_until = greatest(coalesce(blocked_until, now()), now() + make_interval(mins => ban_minutes)),
      updated_at = now()
    where ip_address = rec.source_ip;

    -- Optional persistent banned_ips table, if present.
    begin
      insert into public.banned_ips (ip_address, reason, is_active, banned_at, expires_at)
      values (
        rec.source_ip,
        'Auto mitigation: ' || rec.incident_type || ' / ' || coalesce(rec.severity, 'unknown'),
        true,
        now(),
        now() + make_interval(mins => ban_minutes)
      )
      on conflict do nothing;
    exception when undefined_table or undefined_column then
      null;
    end;

    update public.security_incidents
    set status = 'auto_mitigated'
    where id = rec.id;

    insert into public.security_auto_mitigations (
      incident_id,
      source_ip,
      mitigation_type,
      reason,
      severity,
      confidence_score,
      autonomy_level,
      action_result
    ) values (
      rec.id,
      rec.source_ip,
      'temporary_ip_throttle',
      'High-confidence SOC incident auto-mitigated for ' || ban_minutes || ' minutes',
      rec.severity,
      rec.confidence_score,
      rec.autonomy_level,
      jsonb_build_object('ban_minutes', ban_minutes, 'status', 'applied')
    );

    applied_count := applied_count + 1;
  end loop;

  return jsonb_build_object(
    'applied', applied_count,
    'skipped', skipped_count,
    'executed_at', now()
  );
end;
$$;

revoke all on function public.apply_security_auto_mitigations() from public;
revoke all on function public.apply_security_auto_mitigations() from anon;
revoke all on function public.apply_security_auto_mitigations() from authenticated;

-- Helper wrapper called by cron after security-monitor.
create or replace function public.security_monitor_cron_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  project_url text;
  service_role text;
begin
  -- Configure these as database settings or adapt to your Supabase project URL.
  project_url := current_setting('app.supabase_url', true);

  if project_url is null or length(project_url) = 0 then
    raise notice 'app.supabase_url is not set; skipping security-monitor http call';
  else
    begin
      select decrypted_secret into service_role
      from vault.decrypted_secrets
      where name = 'service_role_key'
      limit 1;

      if service_role is not null and length(service_role) > 0 then
        perform net.http_post(
          url := project_url || '/functions/v1/security-monitor',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || service_role,
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 15000
        );
      else
        raise notice 'Vault secret service_role_key missing; skipping security-monitor http call';
      end if;
    exception when others then
      raise notice 'security-monitor http call failed: %', sqlerrm;
    end;
  end if;

  perform public.apply_security_auto_mitigations();
end;
$$;

revoke all on function public.security_monitor_cron_tick() from public;
revoke all on function public.security_monitor_cron_tick() from anon;
revoke all on function public.security_monitor_cron_tick() from authenticated;

-- Replace existing schedule safely.
select cron.unschedule('forsure-security-monitor-every-5-min')
where exists (
  select 1 from cron.job where jobname = 'forsure-security-monitor-every-5-min'
);

select cron.schedule(
  'forsure-security-monitor-every-5-min',
  '*/5 * * * *',
  $$ select public.security_monitor_cron_tick(); $$
);

comment on function public.apply_security_auto_mitigations() is
  'Applies controlled defensive mitigations for high-confidence SOC incidents.';

comment on function public.security_monitor_cron_tick() is
  'Cron wrapper: calls security-monitor Edge Function then applies controlled defensive mitigations.';
