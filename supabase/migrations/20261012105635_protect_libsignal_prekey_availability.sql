begin;

-- Une session établie reste utilisable quand le stock de nouvelles préclés
-- est vide. L'autorisation, la liaison de compte et la révocation restent
-- obligatoires ; seul l'établissement d'une nouvelle session consomme un bundle.
create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table(
  device_id text, device_public_key text, device_signing_key text,
  device_authorization_signature text, last_seen_at timestamptz,
  account_identity_key text, account_signing_key text, account_fingerprint text,
  account_binding_signature text, account_binding_version integer, is_routable boolean
)
language sql stable security definer set search_path = public, pg_temp
as $function$
  select device.device_id, device.device_public_key, device.device_signing_key,
    device.device_authorization_signature, device.last_seen_at,
    account.identity_key, account.signing_key, account.fingerprint,
    account.identity_binding_signature, account.identity_binding_version,
    (device.approval_status = 'approved' and device.is_active = true
      and device.revoked_at is null and device.stale_at is null
      and device.crypto_invalid_at is null and device.binding_status = 'bound'
      and device.account_bound_at is not null and device.routing_status = 'ready'
      and device.libsignal_device_number between 1 and 127
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_signing_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
      and account.user_id is not null and account.is_active = true
      and public.aegis_verify_account_binding(account.identity_key, account.signing_key,
        account.fingerprint, account.identity_binding_signature, account.identity_binding_version)
      and public.aegis_verify_device_authorization(device.user_id, device.device_id,
        device.device_public_key, device.device_signing_key, device.device_authorization_signature,
        account.signing_key, account.fingerprint)) as is_routable
  from public.user_devices device
  left join lateral (
    select key.* from public.user_public_keys key
    where key.user_id = device.user_id and key.is_active = true
    order by key.created_at desc limit 1
  ) account on true
  where device.user_id = p_user_id and device.revoked_at is null
  order by device.device_id;
$function$;
revoke all on function public.get_sesame_device_list(uuid) from public, anon;
grant execute on function public.get_sesame_device_list(uuid) to authenticated, service_role;

create table public.libsignal_prekey_claim_limits (
  claimer_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null,
  recipient_device_id text not null,
  window_started_at timestamptz not null default now(),
  claims integer not null default 0 check (claims between 0 and 4),
  primary key (claimer_user_id, recipient_user_id, recipient_device_id),
  foreign key (recipient_user_id, recipient_device_id)
    references public.user_devices(user_id, device_id) on delete cascade
);
alter table public.libsignal_prekey_claim_limits enable row level security;
revoke all on table public.libsignal_prekey_claim_limits from public, anon, authenticated;
grant all on table public.libsignal_prekey_claim_limits to service_role;
create index libsignal_prekey_claim_limits_age_idx
  on public.libsignal_prekey_claim_limits(claimer_user_id, window_started_at);

-- Limite par compte émetteur/appareil destinataire (pas par conversation ni
-- onglet) : changer ces identifiants ne permet pas de vider tout le stock.
create or replace function public.claim_libsignal_prekey_bundle(
  p_user_id uuid, p_device_id text, p_conversation_id uuid, p_sender_device_id text
) returns table(device_number smallint, registration_id bigint, public_bundle text)
language plpgsql volatile security definer set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_device text := trim(coalesce(p_device_id, ''));
  v_limit public.libsignal_prekey_claim_limits%rowtype;
  v_bundle public.device_libsignal_prekey_bundles%rowtype;
begin
  if v_uid is null then return; end if;
  perform public.assert_current_login_session_approved();
  if not exists(select 1 from public.conversation_participants where conversation_id=p_conversation_id and user_id=v_uid)
    or not exists(select 1 from public.conversation_participants where conversation_id=p_conversation_id and user_id=p_user_id)
    or not exists(select 1 from public.get_sesame_device_list(v_uid) d where d.device_id=trim(p_sender_device_id) and d.is_routable)
    or not exists(select 1 from public.get_sesame_device_list(p_user_id) d where d.device_id=v_device and d.is_routable)
    or public.aegis_message_block_reason(v_uid, p_user_id) is not null
  then return; end if;

  delete from public.libsignal_prekey_claim_limits
    where claimer_user_id=v_uid and window_started_at < now()-interval '1 day';
  insert into public.libsignal_prekey_claim_limits(claimer_user_id, recipient_user_id, recipient_device_id)
    values (v_uid, p_user_id, v_device) on conflict do nothing;
  select * into strict v_limit from public.libsignal_prekey_claim_limits
    where claimer_user_id=v_uid and recipient_user_id=p_user_id and recipient_device_id=v_device
    for update;
  if v_limit.window_started_at <= now()-interval '10 minutes' then
    v_limit.claims := 0;
    v_limit.window_started_at := now();
  end if;
  if v_limit.claims >= 4 then
    raise exception 'AEGIS_LIBSIGNAL_PREKEY_RATE_LIMITED' using errcode='P0001';
  end if;
  select b.* into v_bundle from public.device_libsignal_prekey_bundles b
    join public.user_devices d on d.user_id=b.user_id and d.device_id=b.device_id
      and d.libsignal_device_number=b.device_number
    where b.user_id=p_user_id and b.device_id=v_device
    order by b.created_at,b.prekey_id limit 1 for update of b skip locked;
  if not found then return; end if;
  delete from public.device_libsignal_prekey_bundles where id=v_bundle.id;
  update public.libsignal_prekey_claim_limits
    set claims=v_limit.claims+1, window_started_at=v_limit.window_started_at
    where claimer_user_id=v_uid and recipient_user_id=p_user_id and recipient_device_id=v_device;
  return query select v_bundle.device_number, v_bundle.registration_id, v_bundle.public_bundle;
end;
$function$;
revoke all on function public.claim_libsignal_prekey_bundle(uuid,text,uuid,text) from public,anon;
grant execute on function public.claim_libsignal_prekey_bundle(uuid,text,uuid,text) to authenticated;

commit;
