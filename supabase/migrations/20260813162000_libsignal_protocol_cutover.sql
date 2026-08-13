-- Bascule vers les bundles officiels libsignal/PQXDH. Le serveur ne reçoit
-- jamais le store sérialisé privé, uniquement le bundle public opaque.

alter table public.user_devices
  add column if not exists libsignal_device_number smallint;

with numbered as (
  select id, row_number() over (partition by user_id order by created_at, id) as n
  from public.user_devices
  where libsignal_device_number is null
)
update public.user_devices d
set libsignal_device_number = numbered.n
from numbered
where d.id = numbered.id and numbered.n between 1 and 127;

alter table public.user_devices
  drop constraint if exists user_devices_libsignal_device_number_check;
alter table public.user_devices
  add constraint user_devices_libsignal_device_number_check
  check (libsignal_device_number between 1 and 127);
create unique index if not exists user_devices_user_libsignal_number_key
  on public.user_devices(user_id, libsignal_device_number)
  where libsignal_device_number is not null;

create or replace function public.assign_libsignal_device_number()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare candidate integer;
begin
  if new.libsignal_device_number is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 19));
  select n into candidate from generate_series(1,127) n
  where not exists(select 1 from public.user_devices d where d.user_id=new.user_id and d.libsignal_device_number=n)
  order by n limit 1;
  if candidate is null then raise exception 'LIBSIGNAL_DEVICE_LIMIT_REACHED'; end if;
  new.libsignal_device_number := candidate;
  return new;
end $$;
drop trigger if exists user_devices_assign_libsignal_number on public.user_devices;
create trigger user_devices_assign_libsignal_number before insert on public.user_devices
for each row execute function public.assign_libsignal_device_number();

create table if not exists public.device_libsignal_prekey_bundles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  device_number smallint not null check (device_number between 1 and 127),
  registration_id bigint not null check (registration_id between 1 and 4294967295),
  prekey_id bigint not null check (prekey_id between 1 and 4294967295),
  signed_prekey_id bigint not null check (signed_prekey_id between 1 and 4294967295),
  kyber_prekey_id bigint not null check (kyber_prekey_id between 1 and 4294967295),
  public_bundle text not null check (length(public_bundle) between 100 and 262144),
  created_at timestamptz not null default now(),
  unique(user_id, device_id, prekey_id),
  foreign key (user_id, device_id) references public.user_devices(user_id, device_id) on delete cascade
);
create index if not exists device_libsignal_bundle_claim_idx
  on public.device_libsignal_prekey_bundles(user_id, device_id, created_at, prekey_id);
alter table public.device_libsignal_prekey_bundles enable row level security;
revoke all on public.device_libsignal_prekey_bundles from public, anon, authenticated;

create or replace function public.publish_libsignal_prekey_bundle(
  p_device_id text,
  p_device_number integer,
  p_registration_id bigint,
  p_prekey_id bigint,
  p_signed_prekey_id bigint,
  p_kyber_prekey_id bigint,
  p_public_bundle text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_device text := trim(coalesce(p_device_id,''));
begin
  if v_uid is null then return jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); end if;
  if p_device_number not between 1 and 127 or length(p_public_bundle) not between 100 and 262144 then
    return jsonb_build_object('ok',false,'code','INVALID_LIBSIGNAL_BUNDLE');
  end if;
  if not exists(select 1 from public.user_devices d where d.user_id=v_uid and d.device_id=v_device
      and d.libsignal_device_number=p_device_number and d.is_active=true and d.revoked_at is null
      and coalesce(d.approval_status,'approved')='approved') then
    return jsonb_build_object('ok',false,'code','DEVICE_NOT_AUTHORIZED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||v_device, 7));
  insert into public.device_libsignal_prekey_bundles(user_id,device_id,device_number,registration_id,prekey_id,signed_prekey_id,kyber_prekey_id,public_bundle)
  values(v_uid,v_device,p_device_number,p_registration_id,p_prekey_id,p_signed_prekey_id,p_kyber_prekey_id,p_public_bundle)
  on conflict(user_id,device_id,prekey_id) do update set public_bundle=excluded.public_bundle
  where public.device_libsignal_prekey_bundles.public_bundle=excluded.public_bundle;
  update public.user_devices set routing_status='ready',routing_error=null,routing_checked_at=now(),updated_at=now()
  where user_id=v_uid and device_id=v_device;
  return jsonb_build_object('ok',true,'code','LIBSIGNAL_BUNDLE_PUBLISHED');
end $$;
revoke all on function public.publish_libsignal_prekey_bundle(text,integer,bigint,bigint,bigint,bigint,text) from public,anon;
grant execute on function public.publish_libsignal_prekey_bundle(text,integer,bigint,bigint,bigint,bigint,text) to authenticated;

create or replace function public.claim_libsignal_prekey_bundle(
  p_user_id uuid, p_device_id text, p_conversation_id uuid, p_sender_device_id text
) returns table(device_number smallint, registration_id bigint, public_bundle text)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists(select 1 from public.conversation_participants where conversation_id=p_conversation_id and user_id=v_uid)
     or not exists(select 1 from public.conversation_participants where conversation_id=p_conversation_id and user_id=p_user_id)
     or not exists(select 1 from public.get_sesame_device_list(v_uid) d where d.device_id=trim(p_sender_device_id) and d.is_routable)
  then return; end if;
  return query with picked as (
    select b.id,b.device_number,b.registration_id,b.public_bundle
    from public.device_libsignal_prekey_bundles b
    where b.user_id=p_user_id and b.device_id=trim(p_device_id)
    order by b.created_at,b.prekey_id limit 1 for update skip locked
  ), consumed as (
    delete from public.device_libsignal_prekey_bundles b using picked where b.id=picked.id
    returning picked.device_number,picked.registration_id,picked.public_bundle
  ) select * from consumed;
end $$;
revoke all on function public.claim_libsignal_prekey_bundle(uuid,text,uuid,text) from public,anon;
grant execute on function public.claim_libsignal_prekey_bundle(uuid,text,uuid,text) to authenticated;

create or replace function public.get_libsignal_device_number(p_user_id uuid,p_device_id text)
returns smallint language sql stable security definer set search_path=public,pg_temp as $$
  select d.libsignal_device_number from public.user_devices d
  where d.user_id=p_user_id and d.device_id=trim(p_device_id) and d.is_active and d.revoked_at is null
    and (p_user_id=auth.uid() or exists(
      select 1 from public.conversation_participants mine join public.conversation_participants peer using(conversation_id)
      where mine.user_id=auth.uid() and peer.user_id=p_user_id));
$$;
revoke all on function public.get_libsignal_device_number(uuid,text) from public,anon;
grant execute on function public.get_libsignal_device_number(uuid,text) to authenticated;

create or replace function public.count_libsignal_prekey_bundles(p_device_id text)
returns integer language sql stable security definer set search_path=public,pg_temp as $$
  select count(*)::integer from public.device_libsignal_prekey_bundles b
  join public.user_devices d on d.user_id=b.user_id and d.device_id=b.device_id
  where b.user_id=auth.uid() and b.device_id=trim(p_device_id)
    and d.is_active and d.revoked_at is null;
$$;
revoke all on function public.count_libsignal_prekey_bundles(text) from public,anon;
grant execute on function public.count_libsignal_prekey_bundles(text) to authenticated;

-- Sesame conserve les preuves d'autorisation AEGIS, mais la disponibilité
-- cryptographique vient désormais exclusivement du pool public Libsignal.
create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table(
  device_id text, device_public_key text, device_signing_key text,
  device_authorization_signature text, last_seen_at timestamptz,
  account_identity_key text, account_signing_key text, account_fingerprint text,
  account_binding_signature text, account_binding_version integer, is_routable boolean
)
language sql stable security definer set search_path=public,pg_temp as $$
  select d.device_id,d.device_public_key,d.device_signing_key,d.device_authorization_signature,d.last_seen_at,
    k.identity_key,k.signing_key,k.fingerprint,k.identity_binding_signature,k.identity_binding_version,
    (d.approval_status='approved' and d.is_active and d.revoked_at is null
      and d.crypto_invalid_at is null and d.binding_status='bound' and d.account_bound_at is not null
      and d.routing_status='ready' and nullif(trim(d.device_public_key),'') is not null
      and nullif(trim(d.device_signing_key),'') is not null
      and nullif(trim(d.device_authorization_signature),'') is not null
      and k.user_id is not null and k.is_active
      and public.aegis_verify_account_binding(k.identity_key,k.signing_key,k.fingerprint,k.identity_binding_signature,k.identity_binding_version)
      and public.aegis_verify_device_authorization(d.user_id,d.device_id,d.device_public_key,d.device_signing_key,d.device_authorization_signature,k.signing_key,k.fingerprint)
      and exists(select 1 from public.device_libsignal_prekey_bundles b where b.user_id=d.user_id and b.device_id=d.device_id)
    ) as is_routable
  from public.user_devices d
  left join lateral (
    select uk.* from public.user_public_keys uk where uk.user_id=d.user_id and uk.is_active
    order by uk.created_at desc limit 1
  ) k on true
  where d.user_id=p_user_id and d.revoked_at is null order by d.device_id;
$$;
revoke all on function public.get_sesame_device_list(uuid) from public,anon;
grant execute on function public.get_sesame_device_list(uuid) to authenticated,service_role;
