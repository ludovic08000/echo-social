begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Invariant cryptographique : ce verrou sérialise l'unique purge des formats
-- antérieurs ; toute dérive des compteurs autorisés annule la transaction.
select pg_advisory_xact_lock(
  hashtextextended('forsure:aegis:libsignal-only-purge:20260915', 0)
);

do $guard$
begin
  if to_regclass('public.device_signed_prekeys') is null
     or to_regclass('public.device_one_time_prekeys') is null
     or to_regclass('public.device_prekey_repair_requests') is null
     or to_regclass('public.aegis_x3dh_initial_replay') is null
     or to_regclass('public.x3dh_replay_ledger') is null then
    raise exception 'LIBSIGNAL_PURGE_SCHEMA_DRIFT';
  end if;
  if to_regprocedure('public.is_supported_aegis_device_copy(text)') is null
     or to_regprocedure('public.get_sesame_device_list(uuid)') is null
     or to_regprocedure('public.revoke_user_device(text)') is null then
    raise exception 'LIBSIGNAL_PURGE_REQUIRED_RPC_MISSING';
  end if;
  if not exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conrelid = 'public.message_device_copies'::regclass
      and constraint_record.conname = 'message_device_copies_libsignal_wire_check'
      and constraint_record.contype = 'c'
  ) then
    raise exception 'LIBSIGNAL_PURGE_COPY_CONSTRAINT_MISSING';
  end if;
end;
$guard$;

lock table
  public.messages,
  public.message_device_copies,
  public.device_copy_retry_requests,
  public.message_device_retry_requests,
  public.aegis_device_inbox,
  public.message_archives,
  public.aegis_view_once_consumptions,
  public.aegis_view_once_payloads,
  public.message_deletions,
  public.message_reactions,
  public.user_devices,
  public.device_libsignal_prekey_bundles,
  public.device_signed_prekeys,
  public.device_one_time_prekeys,
  public.device_prekey_repair_requests,
  public.aegis_x3dh_initial_replay,
  public.x3dh_replay_ledger
in share row exclusive mode;

-- Cette table a déjà été supprimée par le cutover Aegis lors d'un replay neuf,
-- mais existe encore sur la production historique. Elle reste obligatoire via
-- le profil et le compteur production ci-dessous.
do $lock_optional_user_spk$
begin
  if to_regclass('public.user_signed_prekeys') is not null then
    execute 'lock table public.user_signed_prekeys in share row exclusive mode';
  end if;
end;
$lock_optional_user_spk$;

create temporary table _aegis_legacy_copy_target
on commit drop
as
select copy.id, copy.message_id
from public.message_device_copies copy
where not public.is_supported_aegis_device_copy(copy.encrypted_body);

alter table _aegis_legacy_copy_target add primary key (id);

create temporary table _aegis_legacy_message_target
on commit drop
as
select message.id
from public.messages message
where not exists (
  select 1
  from public.message_device_copies copy
  where copy.message_id = message.id
    and public.is_supported_aegis_device_copy(copy.encrypted_body)
);

alter table _aegis_legacy_message_target add primary key (id);

create temporary table _aegis_purge_context (
  mode text primary key check (mode in ('production', 'fresh'))
)
on commit drop;

do $counts$
declare
  v_legacy_copies bigint;
  v_supported_copies bigint;
  v_target_messages bigint;
  v_all_messages bigint;
  v_retry_targets bigint;
  v_all_retries bigint;
  v_inbox_targets bigint;
  v_all_inbox bigint;
  v_archives bigint;
  v_all_archives bigint;
  v_view_once_consumptions bigint;
  v_view_once_payloads bigint;
  v_message_deletions bigint;
  v_message_reactions bigint;
  v_message_retries bigint;
  v_x3dh_initial bigint;
  v_x3dh_ledger bigint;
  v_device_spk bigint;
  v_device_opk bigint;
  v_user_spk bigint;
  v_repair_requests bigint;
  v_devices bigint;
  v_devices_without_bundle bigint;
  v_active_devices_without_bundle bigint;
  v_bundles bigint;
  v_bundle_devices bigint;
  v_bundle_users bigint;
  v_cron_jobs bigint;
begin
  select count(*) into v_legacy_copies from _aegis_legacy_copy_target;
  select count(*) into v_supported_copies
  from public.message_device_copies copy
  where public.is_supported_aegis_device_copy(copy.encrypted_body);
  select count(*) into v_target_messages from _aegis_legacy_message_target;
  select count(*) into v_all_messages from public.messages;
  select count(*) into v_retry_targets
  from public.device_copy_retry_requests retry
  join _aegis_legacy_message_target target on target.id = retry.message_id;
  select count(*) into v_all_retries from public.device_copy_retry_requests;
  select count(*) into v_inbox_targets
  from public.aegis_device_inbox inbox
  join _aegis_legacy_copy_target target on target.id = inbox.copy_id;
  select count(*) into v_all_inbox from public.aegis_device_inbox;
  select count(*) into v_archives
  from public.message_archives archive
  join _aegis_legacy_message_target target on target.id = archive.message_id;
  select count(*) into v_all_archives from public.message_archives;
  select count(*) into v_view_once_consumptions from public.aegis_view_once_consumptions;
  select count(*) into v_view_once_payloads from public.aegis_view_once_payloads;
  select count(*) into v_message_deletions from public.message_deletions;
  select count(*) into v_message_reactions from public.message_reactions;
  select count(*) into v_message_retries from public.message_device_retry_requests;
  select count(*) into v_x3dh_initial from public.aegis_x3dh_initial_replay;
  select count(*) into v_x3dh_ledger from public.x3dh_replay_ledger;
  select count(*) into v_device_spk from public.device_signed_prekeys;
  select count(*) into v_device_opk from public.device_one_time_prekeys;
  if to_regclass('public.user_signed_prekeys') is null then
    v_user_spk := 0;
  else
    execute 'select count(*) from public.user_signed_prekeys' into v_user_spk;
  end if;
  select count(*) into v_repair_requests from public.device_prekey_repair_requests;
  select count(*) into v_devices from public.user_devices;
  select count(*) into v_devices_without_bundle
  from public.user_devices device
  where device.revoked_at is null
    and not exists (
      select 1
      from public.device_libsignal_prekey_bundles bundle
      where bundle.user_id = device.user_id
        and bundle.device_id = device.device_id
    );
  select count(*) into v_active_devices_without_bundle
  from public.user_devices device
  where device.revoked_at is null
    and device.is_active = true
    and not exists (
      select 1
      from public.device_libsignal_prekey_bundles bundle
      where bundle.user_id = device.user_id
        and bundle.device_id = device.device_id
    );
  select count(*), count(distinct (bundle.user_id, bundle.device_id)),
         count(distinct bundle.user_id)
  into v_bundles, v_bundle_devices, v_bundle_users
  from public.device_libsignal_prekey_bundles bundle;
  if to_regclass('cron.job') is null then
    v_cron_jobs := 0;
  else
    execute $query$
      select count(*)
      from cron.job job
      where job.command ilike '%cleanup_expired_device_prekeys%'
         or job.command ilike '%device_one_time_prekeys%'
    $query$
    into v_cron_jobs;
  end if;

  if not (
     v_legacy_copies <> 43
     or v_supported_copies <> 0
     or v_target_messages <> 56
     or v_all_messages <> 56
     or v_retry_targets <> 145
     or v_all_retries <> 145
     or v_inbox_targets <> 43
     or v_all_inbox <> 43
     or v_archives <> 32
     or v_all_archives <> 32
     or v_view_once_consumptions <> 0
     or v_view_once_payloads <> 0
     or v_message_deletions <> 0
     or v_message_reactions <> 0
     or v_message_retries <> 0
     or v_x3dh_initial <> 1
     or v_x3dh_ledger <> 0
     or v_device_spk <> 12
     or v_device_opk <> 589
     or v_user_spk <> 74
     or v_repair_requests <> 0
     or v_devices <> 20
     or v_devices_without_bundle <> 18
     or v_active_devices_without_bundle <> 11
     or v_bundles <> 40
     or v_bundle_devices <> 2
     or v_bundle_users <> 1
     or v_cron_jobs <> 2
  ) then
    insert into _aegis_purge_context(mode) values ('production');
  elsif not (
     v_legacy_copies <> 0
     or v_supported_copies <> 0
     or v_target_messages <> 0
     or v_all_messages <> 0
     or v_retry_targets <> 0
     or v_all_retries <> 0
     or v_inbox_targets <> 0
     or v_all_inbox <> 0
     or v_archives <> 0
     or v_all_archives <> 0
     or v_view_once_consumptions <> 0
     or v_view_once_payloads <> 0
     or v_message_deletions <> 0
     or v_message_reactions <> 0
     or v_message_retries <> 0
     or v_x3dh_initial <> 0
     or v_x3dh_ledger <> 0
     or v_device_spk <> 0
     or v_device_opk <> 0
     or v_user_spk <> 0
     or v_repair_requests <> 0
     or v_devices <> 0
     or v_devices_without_bundle <> 0
     or v_active_devices_without_bundle <> 0
     or v_bundles <> 0
     or v_bundle_devices <> 0
     or v_bundle_users <> 0
     or v_cron_jobs <> 0
  ) then
    insert into _aegis_purge_context(mode) values ('fresh');
  else
    raise exception
      'LIBSIGNAL_PURGE_COUNT_DRIFT copies=%/% messages=%/% retries=%/% inbox=%/% archives=%/% view_once=%/% deletions=% reactions=% message_retries=% x3dh=%/% spk=% opk=% user_spk=% repairs=% devices=% missing=% active_missing=% bundles=%/%/% cron=%',
      v_legacy_copies, v_supported_copies, v_target_messages, v_all_messages,
      v_retry_targets, v_all_retries, v_inbox_targets, v_all_inbox,
      v_archives, v_all_archives, v_view_once_consumptions, v_view_once_payloads,
      v_message_deletions, v_message_reactions, v_message_retries,
      v_x3dh_initial, v_x3dh_ledger,
      v_device_spk, v_device_opk, v_user_spk, v_repair_requests,
      v_devices, v_devices_without_bundle, v_active_devices_without_bundle,
      v_bundles, v_bundle_devices, v_bundle_users, v_cron_jobs;
  end if;
end;
$counts$;

do $purge_rows$
declare
  v_deleted bigint;
  v_mode text;
begin
  select context.mode into strict v_mode from _aegis_purge_context context;

  delete from public.device_copy_retry_requests retry
  using _aegis_legacy_message_target target
  where retry.message_id = target.id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> (case when v_mode = 'production' then 145 else 0 end) then
    raise exception 'LIBSIGNAL_PURGE_RETRY_DELETE_DRIFT:%', v_deleted;
  end if;

  delete from public.aegis_device_inbox inbox
  using _aegis_legacy_copy_target target
  where inbox.copy_id = target.id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> (case when v_mode = 'production' then 43 else 0 end) then
    raise exception 'LIBSIGNAL_PURGE_INBOX_DELETE_DRIFT:%', v_deleted;
  end if;

  delete from public.message_device_copies copy
  using _aegis_legacy_copy_target target
  where copy.id = target.id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> (case when v_mode = 'production' then 43 else 0 end) then
    raise exception 'LIBSIGNAL_PURGE_COPY_DELETE_DRIFT:%', v_deleted;
  end if;

  delete from public.messages message
  using _aegis_legacy_message_target target
  where message.id = target.id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> (case when v_mode = 'production' then 56 else 0 end) then
    raise exception 'LIBSIGNAL_PURGE_MESSAGE_DELETE_DRIFT:%', v_deleted;
  end if;

  delete from public.aegis_x3dh_initial_replay;
  get diagnostics v_deleted = row_count;
  if v_deleted <> (case when v_mode = 'production' then 1 else 0 end) then
    raise exception 'LIBSIGNAL_PURGE_X3DH_DELETE_DRIFT:%', v_deleted;
  end if;
end;
$purge_rows$;

-- Le contrôle avait été ajouté NOT VALID pour permettre la transition. Après
-- suppression vérifiée de toutes les copies historiques, il devient une
-- invariant globale : aucune copie non Libsignal ne pourra rester en base.
alter table public.message_device_copies
  validate constraint message_device_copies_libsignal_wire_check;

do $repair_routes$
declare
  v_updated bigint;
  v_mode text;
begin
  select context.mode into strict v_mode from _aegis_purge_context context;

  update public.user_devices device
  set routing_status = 'repairing',
      routing_error = 'LIBSIGNAL_BUNDLE_REQUIRED',
      routing_checked_at = now(),
      updated_at = now()
  where device.revoked_at is null
    and not exists (
      select 1
      from public.device_libsignal_prekey_bundles bundle
      where bundle.user_id = device.user_id
        and bundle.device_id = device.device_id
    );
  get diagnostics v_updated = row_count;
  if v_updated <> (case when v_mode = 'production' then 18 else 0 end) then
    raise exception 'LIBSIGNAL_PURGE_DEVICE_REPAIR_DRIFT:%', v_updated;
  end if;
end;
$repair_routes$;

-- Les vérifications d'identité Aegis restent obligatoires ; seule la
-- disponibilité cryptographique vient du pool public Libsignal.
create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table(
  device_id text,
  device_public_key text,
  device_signing_key text,
  device_authorization_signature text,
  last_seen_at timestamptz,
  account_identity_key text,
  account_signing_key text,
  account_fingerprint text,
  account_binding_signature text,
  account_binding_version integer,
  is_routable boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    device.device_id,
    device.device_public_key,
    device.device_signing_key,
    device.device_authorization_signature,
    device.last_seen_at,
    account.identity_key,
    account.signing_key,
    account.fingerprint,
    account.identity_binding_signature,
    account.identity_binding_version,
    (
      device.approval_status = 'approved'
      and device.is_active = true
      and device.revoked_at is null
      and device.stale_at is null
      and device.crypto_invalid_at is null
      and device.binding_status = 'bound'
      and device.account_bound_at is not null
      and device.routing_status = 'ready'
      and device.libsignal_device_number between 1 and 127
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_signing_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
      and account.user_id is not null
      and account.is_active = true
      and public.aegis_verify_account_binding(
        account.identity_key,
        account.signing_key,
        account.fingerprint,
        account.identity_binding_signature,
        account.identity_binding_version
      )
      and public.aegis_verify_device_authorization(
        device.user_id,
        device.device_id,
        device.device_public_key,
        device.device_signing_key,
        device.device_authorization_signature,
        account.signing_key,
        account.fingerprint
      )
      and exists (
        select 1
        from public.device_libsignal_prekey_bundles bundle
        where bundle.user_id = device.user_id
          and bundle.device_id = device.device_id
          and bundle.device_number = device.libsignal_device_number
          and length(bundle.public_bundle) between 100 and 262144
      )
    ) as is_routable
  from public.user_devices device
  left join lateral (
    select key.*
    from public.user_public_keys key
    where key.user_id = device.user_id
      and key.is_active = true
    order by key.created_at desc
    limit 1
  ) account on true
  where device.user_id = p_user_id
    and device.revoked_at is null
  order by device.device_id;
$function$;

revoke all on function public.get_sesame_device_list(uuid) from public, anon;
grant execute on function public.get_sesame_device_list(uuid)
  to authenticated, service_role;

-- Révoquer un appareil détruit désormais uniquement son pool public
-- Libsignal ; aucune préclé privée ou custom n'existe côté serveur.
create or replace function public.revoke_user_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_target public.user_devices%rowtype;
  v_now timestamptz := now();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if v_device_id !~ '^(dev_)?[a-f0-9]{32}$' then
    raise exception 'INVALID_DEVICE_ID' using errcode = '22023';
  end if;

  select *
  into v_target
  from public.user_devices device
  where device.user_id = v_uid
    and device.device_id = v_device_id
    and device.revoked_at is null
  for update;
  if not found then
    raise exception 'DEVICE_NOT_FOUND_OR_ALREADY_REVOKED' using errcode = 'P0002';
  end if;

  update public.user_devices
  set is_active = false,
      revoked_at = v_now,
      revoke_reason = 'manual',
      stale_at = coalesce(stale_at, v_now),
      binding_status = 'revoked',
      routing_status = 'unavailable',
      routing_error = 'DEVICE_REVOKED',
      routing_checked_at = v_now,
      updated_at = v_now
  where id = v_target.id;

  delete from public.device_libsignal_prekey_bundles bundle
  where bundle.user_id = v_uid
    and bundle.device_id = v_device_id;

  return jsonb_build_object(
    'ok', true,
    'device_id', v_device_id,
    'status', 'revoked'
  );
end;
$function$;

revoke all on function public.revoke_user_device(text) from public, anon;
grant execute on function public.revoke_user_device(text)
  to authenticated, service_role;

do $remove_cron$
declare
  v_job record;
  v_removed integer := 0;
  v_mode text;
begin
  select context.mode into strict v_mode from _aegis_purge_context context;

  if to_regclass('cron.job') is not null then
    for v_job in execute $query$
      select job.jobid
      from cron.job job
      where job.command ilike '%cleanup_expired_device_prekeys%'
         or job.command ilike '%device_one_time_prekeys%'
      order by job.jobid
    $query$
    loop
      execute 'select cron.unschedule($1)' using v_job.jobid;
      v_removed := v_removed + 1;
    end loop;
  end if;

  if v_removed <> (case when v_mode = 'production' then 2 else 0 end) then
    raise exception 'LIBSIGNAL_PURGE_CRON_DRIFT:%', v_removed;
  end if;
end;
$remove_cron$;

drop function if exists public.publish_device_signed_prekey(text,integer,text,text);
drop function if exists public.publish_device_signed_prekey_pre_signal_validation(text,integer,text,text);
drop function if exists public.publish_device_one_time_prekeys(text,jsonb);
drop function if exists public.publish_device_one_time_prekeys_pre_signal_validation(text,jsonb);
drop function if exists public.claim_device_one_time_prekey(uuid,text,uuid,text);
drop function if exists public.count_device_one_time_prekeys(uuid,text);
drop function if exists public.cleanup_expired_device_prekeys();
drop function if exists public.get_current_device_prekey_inventory(text);
drop function if exists public.get_device_prekey_bundle(uuid,text);
drop function if exists public.get_signed_prekey_with_fallback(uuid);
drop function if exists public.get_signed_prekey(uuid);
drop function if exists public.bump_device_keys_epoch(uuid,text);
drop function if exists public.quarantine_ghost_e2ee_devices();
drop function if exists public.quarantine_own_invalid_device_spk(text,integer,text);
drop function if exists public.request_device_prekey_repair(uuid,text,text);
drop function if exists public.consume_device_prekey_repair_requests(integer);
drop function if exists public.reserve_x3dh_initial(text,integer);
drop function if exists public.finalize_x3dh_initial(text,uuid);
drop function if exists public.cancel_x3dh_initial(text,uuid);
drop function if exists public.claim_x3dh_initial(text);

drop trigger if exists bump_aegis_signed_prekey_route
  on public.device_signed_prekeys;
drop function if exists public.aegis_verify_signed_prekey(text,text,text);

-- Aucun CASCADE : une dépendance inconnue doit faire échouer et annuler toute
-- la purge plutôt que supprimer silencieusement un objet Aegis actif.
drop table public.device_prekey_repair_requests;
drop table public.device_one_time_prekeys;
drop table public.device_signed_prekeys;
drop table if exists public.user_signed_prekeys;
drop table public.aegis_x3dh_initial_replay;
drop table public.x3dh_replay_ledger;

do $postconditions$
declare
  v_stale_functions bigint;
  v_stale_cron boolean := false;
  v_mode text;
begin
  select context.mode into strict v_mode from _aegis_purge_context context;

  if exists (
    select 1
    from public.messages
  ) or exists (
    select 1
    from public.message_device_copies
  ) or exists (
    select 1
    from public.device_copy_retry_requests
  ) or exists (
    select 1
    from public.aegis_device_inbox
  ) or exists (
    select 1
    from public.message_archives
  ) or exists (
    select 1
    from public.aegis_view_once_consumptions
  ) or exists (
    select 1
    from public.aegis_view_once_payloads
  ) or exists (
    select 1
    from public.message_deletions
  ) or exists (
    select 1
    from public.message_reactions
  ) then
    raise exception 'LIBSIGNAL_PURGE_MESSAGE_POSTCONDITION_FAILED';
  end if;

  if (select count(*) from public.user_devices)
       <> (case when v_mode = 'production' then 20 else 0 end)
     or (select count(*) from public.device_libsignal_prekey_bundles)
       <> (case when v_mode = 'production' then 40 else 0 end)
     or (
       select count(distinct (bundle.user_id, bundle.device_id))
       from public.device_libsignal_prekey_bundles bundle
     ) <> (case when v_mode = 'production' then 2 else 0 end)
     or (
       select count(*)
       from public.user_devices device
       where device.revoked_at is null
         and not exists (
           select 1
           from public.device_libsignal_prekey_bundles bundle
           where bundle.user_id = device.user_id
             and bundle.device_id = device.device_id
         )
         and (
           device.routing_status <> 'repairing'
           or device.routing_error <> 'LIBSIGNAL_BUNDLE_REQUIRED'
         )
     ) <> 0 then
    raise exception 'LIBSIGNAL_PURGE_ROUTE_POSTCONDITION_FAILED';
  end if;

  if to_regclass('public.device_signed_prekeys') is not null
     or to_regclass('public.device_one_time_prekeys') is not null
     or to_regclass('public.user_signed_prekeys') is not null
     or to_regclass('public.device_prekey_repair_requests') is not null
     or to_regclass('public.aegis_x3dh_initial_replay') is not null
     or to_regclass('public.x3dh_replay_ledger') is not null then
    raise exception 'LIBSIGNAL_PURGE_TABLE_POSTCONDITION_FAILED';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conrelid = 'public.message_device_copies'::regclass
      and constraint_record.conname = 'message_device_copies_libsignal_wire_check'
      and constraint_record.contype = 'c'
      and constraint_record.convalidated = true
  ) then
    raise exception 'LIBSIGNAL_PURGE_COPY_CONSTRAINT_NOT_VALIDATED';
  end if;

  select count(*)
  into v_stale_functions
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and (
      procedure.proname = any (array[
        'aegis_verify_signed_prekey',
        'bump_device_keys_epoch',
        'cancel_x3dh_initial',
        'claim_device_one_time_prekey',
        'claim_x3dh_initial',
        'cleanup_expired_device_prekeys',
        'consume_device_prekey_repair_requests',
        'count_device_one_time_prekeys',
        'finalize_x3dh_initial',
        'get_current_device_prekey_inventory',
        'get_device_prekey_bundle',
        'get_signed_prekey',
        'get_signed_prekey_with_fallback',
        'publish_device_one_time_prekeys',
        'publish_device_one_time_prekeys_pre_signal_validation',
        'publish_device_signed_prekey',
        'publish_device_signed_prekey_pre_signal_validation',
        'quarantine_ghost_e2ee_devices',
        'quarantine_own_invalid_device_spk',
        'request_device_prekey_repair',
        'reserve_x3dh_initial'
      ])
      or procedure.prosrc ilike any (array[
        '%device_signed_prekeys%',
        '%device_one_time_prekeys%',
        '%user_signed_prekeys%',
        '%aegis_x3dh_initial_replay%',
        '%x3dh_replay_ledger%',
        '%aegis_verify_signed_prekey%',
        '%bump_device_keys_epoch%',
        '%cancel_x3dh_initial%',
        '%claim_device_one_time_prekey%',
        '%claim_x3dh_initial%',
        '%cleanup_expired_device_prekeys%',
        '%consume_device_prekey_repair_requests%',
        '%count_device_one_time_prekeys%',
        '%finalize_x3dh_initial%',
        '%get_current_device_prekey_inventory%',
        '%get_device_prekey_bundle%',
        '%get_signed_prekey%',
        '%publish_device_one_time_prekeys%',
        '%publish_device_signed_prekey%',
        '%quarantine_ghost_e2ee_devices%',
        '%quarantine_own_invalid_device_spk%',
        '%request_device_prekey_repair%',
        '%reserve_x3dh_initial%'
      ])
    );
  if v_stale_functions <> 0 then
    raise exception 'LIBSIGNAL_PURGE_FUNCTION_POSTCONDITION_FAILED:%', v_stale_functions;
  end if;

  if to_regclass('cron.job') is not null then
    execute $query$
      select exists (
        select 1
        from cron.job job
        where job.command ilike '%cleanup_expired_device_prekeys%'
           or job.command ilike '%device_one_time_prekeys%'
      )
    $query$
    into v_stale_cron;
  end if;
  if v_stale_cron then
    raise exception 'LIBSIGNAL_PURGE_CRON_POSTCONDITION_FAILED';
  end if;
end;
$postconditions$;

notify pgrst, 'reload schema';

commit;
