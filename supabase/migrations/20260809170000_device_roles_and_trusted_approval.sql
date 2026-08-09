begin;

-- Invariant Aegis : le premier appareil est l'unique primary ; tout appareil
-- suivant est secondary et doit être approuvé par un autre appareil ready.
alter table public.user_devices
  add column if not exists device_role text,
  add column if not exists lifecycle_status text,
  add column if not exists approved_by_device_id text,
  add column if not exists rejected_by_device_id text;

update public.user_devices d
set device_role = case
      when d.device_id = (
        select first_device.device_id
        from public.user_devices first_device
        where first_device.user_id = d.user_id
          and first_device.revoked_at is null
        order by first_device.created_at asc, first_device.device_id asc
        limit 1
      ) then 'primary'
      else 'secondary'
    end,
    lifecycle_status = case
      when d.revoked_at is not null or d.approval_status = 'rejected' then 'revoked'
      when d.approval_status <> 'approved' then 'pending'
      when d.routing_status = 'ready' and d.binding_status = 'bound' and d.is_active then 'ready'
      when d.binding_status = 'bound' then 'syncing'
      else 'approved'
    end
where d.device_role is null or d.lifecycle_status is null;

alter table public.user_devices
  alter column device_role set default 'secondary',
  alter column device_role set not null,
  alter column lifecycle_status set default 'pending',
  alter column lifecycle_status set not null;

alter table public.user_devices drop constraint if exists user_devices_device_role_check;
alter table public.user_devices add constraint user_devices_device_role_check
  check (device_role in ('primary', 'secondary'));

alter table public.user_devices drop constraint if exists user_devices_lifecycle_status_check;
alter table public.user_devices add constraint user_devices_lifecycle_status_check
  check (lifecycle_status in ('pending', 'approved', 'syncing', 'ready', 'revoked'));

create unique index if not exists user_devices_one_live_primary
  on public.user_devices(user_id)
  where device_role = 'primary' and revoked_at is null;

create or replace function public.notify_pending_secondary_device()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.approval_status = 'pending' and exists (
    select 1 from public.user_devices trusted
    where trusted.user_id = new.user_id and trusted.device_id <> new.device_id
      and trusted.lifecycle_status = 'ready' and trusted.revoked_at is null
  ) then
    insert into public.notifications(user_id, actor_id, type, metadata)
    values(new.user_id, new.user_id, 'new_device', jsonb_build_object(
      'device_id', new.device_id, 'device_name', new.device_name,
      'platform', new.platform, 'approval_required', true
    ));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_pending_secondary_device on public.user_devices;
create trigger trg_notify_pending_secondary_device
after insert on public.user_devices
for each row execute function public.notify_pending_secondary_device();

revoke all on function public.notify_pending_secondary_device() from public, anon, authenticated;

create or replace function public.finalize_device_approval_decision(
  p_user_id uuid,
  p_target_device_id text,
  p_challenge_id uuid,
  p_decision text,
  p_approver_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.user_devices%rowtype;
  v_approver public.user_devices%rowtype;
  v_live_count integer;
  v_now timestamptz := now();
  v_is_bootstrap boolean;
begin
  if p_user_id is null or p_target_device_id !~ '^dev_[a-f0-9]{32}$'
     or p_challenge_id is null or p_decision not in ('approve', 'reject') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_DECISION');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_target from public.user_devices d
  where d.user_id = p_user_id and d.device_id = p_target_device_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND'); end if;
  if v_target.approval_challenge_id is distinct from p_challenge_id
     or v_target.approval_status <> 'pending' or v_target.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_PENDING');
  end if;

  select count(*) into v_live_count from public.user_devices d
  where d.user_id = p_user_id and d.device_id <> p_target_device_id
    and d.approval_status = 'approved' and d.is_active = true
    and d.revoked_at is null and d.lifecycle_status = 'ready';
  v_is_bootstrap := v_live_count = 0 and not exists (
    select 1 from public.user_devices d
    where d.user_id = p_user_id and d.device_id <> p_target_device_id
  );

  if not v_is_bootstrap then
    if p_approver_device_id is null or p_approver_device_id = p_target_device_id then
      return jsonb_build_object('ok', false, 'code', 'TRUSTED_APPROVER_REQUIRED');
    end if;
    select * into v_approver from public.user_devices d
    where d.user_id = p_user_id and d.device_id = p_approver_device_id for update;
    if not found or v_approver.approval_status <> 'approved' or not v_approver.is_active
       or v_approver.revoked_at is not null or v_approver.lifecycle_status <> 'ready' then
      return jsonb_build_object('ok', false, 'code', 'APPROVER_DEVICE_NOT_READY');
    end if;
  end if;

  if p_decision = 'reject' then
    update public.user_devices set approval_status = 'rejected', is_active = false,
      lifecycle_status = 'revoked', rejected_at = v_now, rejected_by = p_user_id,
      rejected_by_device_id = p_approver_device_id, revoked_at = v_now,
      revoke_reason = 'user_rejected_pending_device', stale_at = v_now,
      binding_status = 'revoked', routing_status = 'unavailable',
      routing_error = 'DEVICE_REJECTED', updated_at = v_now
    where id = v_target.id;
    return jsonb_build_object('ok', true, 'code', 'DEVICE_REVOKED',
      'device_id', p_target_device_id, 'approver_device_id', p_approver_device_id);
  end if;

  update public.user_devices set
    device_role = case when v_is_bootstrap then 'primary' else 'secondary' end,
    approval_status = 'approved', lifecycle_status = 'approved', is_active = true,
    approved_at = v_now, approved_by = p_user_id,
    approved_by_device_id = case when v_is_bootstrap then null else p_approver_device_id end,
    rejected_by_device_id = null, possession_verified_at = coalesce(possession_verified_at, v_now),
    routing_status = 'repairing', routing_error = 'DEVICE_SYNC_REQUIRED', updated_at = v_now
  where id = v_target.id;

  return jsonb_build_object('ok', true, 'code', 'DEVICE_APPROVED',
    'device_id', p_target_device_id,
    'device_role', case when v_is_bootstrap then 'primary' else 'secondary' end,
    'approver_device_id', p_approver_device_id);
end;
$$;

revoke all on function public.finalize_device_approval_decision(uuid,text,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_device_approval_decision(uuid,text,uuid,text,text)
  to service_role;

create or replace function public.complete_current_device_synchronization(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device public.user_devices%rowtype;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;
  select * into v_device from public.user_devices d
  where d.user_id = v_uid and d.device_id = trim(p_device_id) for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND'); end if;
  if v_device.revoked_at is not null or v_device.approval_status <> 'approved'
     or not v_device.is_active or v_device.binding_status <> 'bound'
     or v_device.routing_status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_SYNCHRONIZATION_INCOMPLETE');
  end if;
  update public.user_devices set lifecycle_status = 'ready', updated_at = now()
  where id = v_device.id;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_READY', 'device_id', v_device.device_id);
end;
$$;

revoke all on function public.complete_current_device_synchronization(text) from public, anon;
grant execute on function public.complete_current_device_synchronization(text) to authenticated, service_role;

-- L'ancien finaliseur d'auto-approbation est supprimé. Une ancienne Edge
-- Function échoue ainsi fermée jusqu'au déploiement du nouveau serveur.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure signature from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finalize_self_approved_device'
  loop
    execute format('drop function if exists %s', r.signature);
  end loop;
end $$;

-- La liaison de compte reste utilisée par l'Edge Function, exclusivement avec
-- la service-role après vérification cryptographique côté serveur.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure signature from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finalize_device_account_binding'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
