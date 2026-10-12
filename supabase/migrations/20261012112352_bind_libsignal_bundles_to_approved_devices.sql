-- Pilote isolé obligatoire : cette migration remplace les RPC de préclés.
-- Ne pas l'appliquer au Cloud de production avant validation iOS/Windows.
begin;

alter table public.device_libsignal_prekey_bundles
  add column bundle_signature text,
  add column bundle_signing_key text;
alter table public.device_libsignal_prekey_bundles add constraint libsignal_bundle_proof_shape
  check ((bundle_signature is null and bundle_signing_key is null)
    or (bundle_signature is not null and bundle_signing_key is not null
      and length(bundle_signature)=88 and length(bundle_signing_key)=44));

create function public.libsignal_bundle_binding_payload(
  p_user_id uuid,p_device_id text,p_device_number integer,p_registration_id bigint,p_public_bundle text
) returns text language sql immutable set search_path=public,pg_temp as $$
  select '{"protocol":"forsure-libsignal-device-bundle","userId":' || to_json(p_user_id::text)::text
    || ',"deviceId":' || to_json(p_device_id)::text || ',"deviceNumber":' || p_device_number::text
    || ',"registrationId":' || p_registration_id::text || ',"publicBundle":' || to_json(p_public_bundle)::text || '}';
$$;
revoke all on function public.libsignal_bundle_binding_payload(uuid,text,integer,bigint,text) from public,anon,authenticated;

-- L'en-tête est un contrôle de compatibilité, pas une preuve d'identité :
-- les signatures, l'approbation de session et les permissions restent exigées.
create function public.assert_current_messaging_client() returns void
language plpgsql stable set search_path=public,pg_temp as $$
begin
  if coalesce(nullif(current_setting('request.headers',true),'')::jsonb
    ->>'x-forsure-messaging-revision','') <> '1' then
    raise exception 'AEGIS_CLIENT_UPDATE_REQUIRED' using errcode='P0001';
  end if;
end $$;
revoke all on function public.assert_current_messaging_client() from public,anon;
grant execute on function public.assert_current_messaging_client() to authenticated,service_role;

-- Aucun ancien bundle n'est effacé : leur présence empêche de recréer un
-- store perdu. Seuls les bundles liés à la clé approuvée sont utilisables.
drop function public.count_libsignal_prekey_bundles(text);
create function public.get_libsignal_prekey_inventory(p_device_id text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  perform public.assert_current_messaging_client();
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.assert_current_login_session_approved();
  select jsonb_build_object('total',count(*),'verified',count(*) filter(
    where b.bundle_signature is not null and b.bundle_signing_key=d.device_signing_key)) into result
    from public.device_libsignal_prekey_bundles b
    join public.user_devices d on d.user_id=b.user_id and d.device_id=b.device_id
    where b.user_id=auth.uid() and b.device_id=trim(p_device_id);
  return result;
end $$;
revoke all on function public.get_libsignal_prekey_inventory(text) from public,anon;
grant execute on function public.get_libsignal_prekey_inventory(text) to authenticated;

drop function public.publish_libsignal_prekey_bundle(text,integer,bigint,bigint,bigint,bigint,text);
create function public.publish_libsignal_prekey_bundle(
  p_device_id text,p_device_number integer,p_registration_id bigint,p_prekey_id bigint,
  p_signed_prekey_id bigint,p_kyber_prekey_id bigint,p_public_bundle text,p_bundle_signature text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_uid uuid := auth.uid(); v_device text := trim(coalesce(p_device_id,''));
  v_key text; v_bytes bytea; v_numbers bigint[] := '{}'; v_n bigint; v_offset integer := 0; v_len bigint;
  v_existing public.device_libsignal_prekey_bundles%rowtype;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.assert_current_messaging_client();
  perform public.assert_current_login_session_approved();
  if p_bundle_signature is null then raise exception 'AEGIS_CLIENT_UPDATE_REQUIRED'; end if;
  if length(p_public_bundle) not between 100 and 262144 or p_public_bundle is null then
    raise exception 'INVALID_LIBSIGNAL_BUNDLE';
  end if;
  -- Le serveur et le client signent exactement le même base64 canonique.
  v_bytes := public.aegis_decode_base64(p_public_bundle);
  if v_bytes is null or replace(encode(v_bytes,'base64'),E'\n','') <> p_public_bundle then
    raise exception 'INVALID_LIBSIGNAL_BUNDLE';
  end if;
  for i in 0..6 loop
    if v_offset+4 > octet_length(v_bytes) then raise exception 'INVALID_LIBSIGNAL_BUNDLE'; end if;
    v_len := get_byte(v_bytes,v_offset)::bigint + (get_byte(v_bytes,v_offset+1)::bigint<<8)
      + (get_byte(v_bytes,v_offset+2)::bigint<<16) + (get_byte(v_bytes,v_offset+3)::bigint<<24);
    v_offset := v_offset+4;
    if v_len < 1 or v_offset+v_len > octet_length(v_bytes) or (i=0 and v_len<>20)
      or (i=1 and (v_len<>33 or get_byte(v_bytes,v_offset)<>5)) then raise exception 'INVALID_LIBSIGNAL_BUNDLE'; end if;
    v_offset := v_offset+v_len::integer;
  end loop;
  if v_offset<>octet_length(v_bytes) then raise exception 'INVALID_LIBSIGNAL_BUNDLE'; end if;
  for i in 0..4 loop
    v_offset := 4+i*4;
    v_n := get_byte(v_bytes,v_offset)::bigint + (get_byte(v_bytes,v_offset+1)::bigint<<8)
      + (get_byte(v_bytes,v_offset+2)::bigint<<16) + (get_byte(v_bytes,v_offset+3)::bigint<<24);
    v_numbers := array_append(v_numbers,v_n);
  end loop;
  if v_numbers is distinct from array[p_registration_id,p_device_number::bigint,p_prekey_id,p_signed_prekey_id,p_kyber_prekey_id]
    or 0=any(v_numbers) or p_device_number not between 1 and 127 then raise exception 'INVALID_LIBSIGNAL_BUNDLE'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||v_device,7));
  select d.device_signing_key into v_key from public.user_devices d
    join lateral (select k.* from public.user_public_keys k where k.user_id=d.user_id and k.is_active
      order by k.created_at desc limit 1) k on true
    where d.user_id=v_uid and d.device_id=v_device and d.libsignal_device_number=p_device_number
      and d.is_active and d.revoked_at is null and d.stale_at is null and d.crypto_invalid_at is null
      and d.approval_status='approved' and d.binding_status='bound' and d.account_bound_at is not null
      and public.aegis_verify_account_binding(k.identity_key,k.signing_key,k.fingerprint,k.identity_binding_signature,k.identity_binding_version)
      and public.aegis_verify_device_authorization(d.user_id,d.device_id,d.device_public_key,d.device_signing_key,
        d.device_authorization_signature,k.signing_key,k.fingerprint)
    for share of d;
  -- routing_status peut encore être « repairing » pendant le provisionnement.
  if v_key is null then raise exception 'DEVICE_NOT_AUTHORIZED'; end if;
  if not public.aegis_verify_ed25519(v_key,p_bundle_signature,convert_to(public.libsignal_bundle_binding_payload(
    v_uid,v_device,p_device_number,p_registration_id,p_public_bundle),'UTF8')) then
    raise exception 'AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID';
  end if;
  select * into v_existing from public.device_libsignal_prekey_bundles
    where user_id=v_uid and device_id=v_device and prekey_id=p_prekey_id for update;
  if found then
    if v_existing.public_bundle<>p_public_bundle or v_existing.device_number<>p_device_number
      or v_existing.registration_id<>p_registration_id or v_existing.signed_prekey_id<>p_signed_prekey_id
      or v_existing.kyber_prekey_id<>p_kyber_prekey_id then raise exception 'AEGIS_LIBSIGNAL_PREKEY_ID_CONFLICT'; end if;
    update public.device_libsignal_prekey_bundles set bundle_signature=p_bundle_signature,bundle_signing_key=v_key where id=v_existing.id;
  else
    insert into public.device_libsignal_prekey_bundles(user_id,device_id,device_number,registration_id,
      prekey_id,signed_prekey_id,kyber_prekey_id,public_bundle,bundle_signature,bundle_signing_key)
      values(v_uid,v_device,p_device_number,p_registration_id,p_prekey_id,p_signed_prekey_id,p_kyber_prekey_id,
        p_public_bundle,p_bundle_signature,v_key);
  end if;
  return jsonb_build_object('ok',true,'code','LIBSIGNAL_BUNDLE_PUBLISHED');
end $$;
revoke all on function public.publish_libsignal_prekey_bundle(text,integer,bigint,bigint,bigint,bigint,text,text) from public,anon;
grant execute on function public.publish_libsignal_prekey_bundle(text,integer,bigint,bigint,bigint,bigint,text,text) to authenticated;

drop function public.claim_libsignal_prekey_bundle(uuid,text,uuid,text);
create function public.claim_libsignal_prekey_bundle(
  p_user_id uuid,p_device_id text,p_conversation_id uuid,p_sender_device_id text
) returns table(device_number smallint,registration_id bigint,public_bundle text,bundle_signature text)
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
  v_uid uuid := auth.uid(); v_device text := trim(coalesce(p_device_id,''));
  v_limit public.libsignal_prekey_claim_limits%rowtype;
  v_bundle public.device_libsignal_prekey_bundles%rowtype;
begin
  if v_uid is null then return; end if;
  perform public.assert_current_messaging_client();
  perform public.assert_current_login_session_approved();
  if not exists(select 1 from public.conversation_participants where conversation_id=p_conversation_id and user_id=v_uid)
    or not exists(select 1 from public.conversation_participants where conversation_id=p_conversation_id and user_id=p_user_id)
    or not exists(select 1 from public.get_sesame_device_list(v_uid) d where d.device_id=trim(p_sender_device_id) and d.is_routable)
    or not exists(select 1 from public.get_sesame_device_list(p_user_id) d where d.device_id=v_device and d.is_routable)
    or public.aegis_message_block_reason(v_uid,p_user_id) is not null then return; end if;
  delete from public.libsignal_prekey_claim_limits where claimer_user_id=v_uid and window_started_at<now()-interval '1 day';
  insert into public.libsignal_prekey_claim_limits(claimer_user_id,recipient_user_id,recipient_device_id)
    values(v_uid,p_user_id,v_device) on conflict do nothing;
  select * into strict v_limit from public.libsignal_prekey_claim_limits
    where claimer_user_id=v_uid and recipient_user_id=p_user_id and recipient_device_id=v_device for update;
  if v_limit.window_started_at<=now()-interval '10 minutes' then v_limit.claims:=0; v_limit.window_started_at:=now(); end if;
  if v_limit.claims>=4 then raise exception 'AEGIS_LIBSIGNAL_PREKEY_RATE_LIMITED'; end if;
  select b.* into v_bundle from public.device_libsignal_prekey_bundles b
    join public.user_devices d on d.user_id=b.user_id and d.device_id=b.device_id and d.libsignal_device_number=b.device_number
    where b.user_id=p_user_id and b.device_id=v_device and b.bundle_signature is not null
      and b.bundle_signing_key=d.device_signing_key
    order by b.created_at,b.prekey_id limit 1 for update of b skip locked;
  if not found then
    if exists(select 1 from public.device_libsignal_prekey_bundles b where b.user_id=p_user_id and b.device_id=v_device
      and b.bundle_signature is null) then raise exception 'AEGIS_PEER_DEVICE_UPDATE_REQUIRED'; end if;
    return;
  end if;
  if not public.aegis_verify_ed25519(v_bundle.bundle_signing_key,v_bundle.bundle_signature,
    convert_to(public.libsignal_bundle_binding_payload(p_user_id,v_device,v_bundle.device_number,
      v_bundle.registration_id,v_bundle.public_bundle),'UTF8')) then raise exception 'AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID'; end if;
  delete from public.device_libsignal_prekey_bundles where id=v_bundle.id;
  update public.libsignal_prekey_claim_limits set claims=v_limit.claims+1,window_started_at=v_limit.window_started_at
    where claimer_user_id=v_uid and recipient_user_id=p_user_id and recipient_device_id=v_device;
  return query select v_bundle.device_number,v_bundle.registration_id,v_bundle.public_bundle,v_bundle.bundle_signature;
end $$;
revoke all on function public.claim_libsignal_prekey_bundle(uuid,text,uuid,text) from public,anon;
grant execute on function public.claim_libsignal_prekey_bundle(uuid,text,uuid,text) to authenticated;

-- Empêche également un ancien client de continuer à émettre avec une session
-- déjà établie. La lecture et les archives restent inchangées.
create function public.require_current_messaging_client_on_insert() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if auth.uid() is not null then perform public.assert_current_messaging_client(); end if;
  return new;
end $$;
revoke all on function public.require_current_messaging_client_on_insert() from public,anon,authenticated;
create trigger messages_require_current_client before insert on public.messages
  for each row execute function public.require_current_messaging_client_on_insert();
create trigger calls_require_current_client before insert on public.active_calls
  for each row execute function public.require_current_messaging_client_on_insert();

commit;
