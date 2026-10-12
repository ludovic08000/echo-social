-- Pilote isolé uniquement. L'attestation publique survit à la consommation des
-- préclés et à la révocation ; elle identifie l'historique, sans autoriser un envoi.
begin;

create table public.libsignal_receive_attestations (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  device_number smallint not null check (device_number between 1 and 127),
  registration_id bigint not null check (registration_id between 1 and 4294967295),
  identity_key text not null check (length(identity_key)=44),
  proof jsonb not null check (jsonb_typeof(proof)='object'),
  created_at timestamptz not null default now(),
  primary key(user_id,device_id)
);
alter table public.libsignal_receive_attestations enable row level security;
revoke all on public.libsignal_receive_attestations from public,anon,authenticated;

create function public.capture_libsignal_receive_attestation() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  d public.user_devices%rowtype; k public.user_public_keys%rowtype;
  previous public.libsignal_receive_attestations%rowtype;
  identity_bytes bytea; identity_key text; proof jsonb;
begin
  if new.bundle_signature is null then return new; end if;
  select * into d from public.user_devices where user_id=new.user_id and device_id=new.device_id for share;
  select * into k from public.user_public_keys where user_id=new.user_id and is_active order by created_at desc limit 1;
  if d.user_id is null or k.user_id is null or d.approval_status is distinct from 'approved'
    or d.is_active is distinct from true or d.revoked_at is not null or d.stale_at is not null
    or d.crypto_invalid_at is not null or d.binding_status is distinct from 'bound' or d.account_bound_at is null
    or d.libsignal_device_number is distinct from new.device_number
    or d.device_signing_key is distinct from new.bundle_signing_key
    or public.aegis_verify_account_binding(k.identity_key,k.signing_key,k.fingerprint,k.identity_binding_signature,k.identity_binding_version) is distinct from true
    or public.aegis_verify_device_authorization(d.user_id,d.device_id,d.device_public_key,d.device_signing_key,
      d.device_authorization_signature,k.signing_key,k.fingerprint) is distinct from true
    or public.aegis_verify_ed25519(d.device_signing_key,new.bundle_signature,convert_to(public.libsignal_bundle_binding_payload(
      new.user_id,new.device_id,new.device_number,new.registration_id,new.public_bundle),'UTF8')) is distinct from true then
    raise exception 'AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID';
  end if;
  identity_bytes := substring(public.aegis_decode_base64(new.public_bundle) from 29 for 33);
  if octet_length(identity_bytes) is distinct from 33 or get_byte(identity_bytes,0)<>5 then
    raise exception 'AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID';
  end if;
  identity_key := replace(encode(identity_bytes,'base64'),E'\n','');
  proof := jsonb_build_object('userId',new.user_id,'deviceId',new.device_id,
    'deviceNumber',new.device_number,'registrationId',new.registration_id,
    'publicBundle',new.public_bundle,'signature',new.bundle_signature,
    'devicePublicKey',d.device_public_key,'deviceSigningKey',d.device_signing_key,
    'deviceAuthorizationSignature',d.device_authorization_signature,
    'accountIdentityKey',k.identity_key,'accountSigningKey',k.signing_key,
    'accountFingerprint',k.fingerprint,'accountBindingSignature',k.identity_binding_signature,
    'accountBindingVersion',k.identity_binding_version);
  insert into public.libsignal_receive_attestations(user_id,device_id,device_number,registration_id,identity_key,proof)
    values(new.user_id,new.device_id,new.device_number,new.registration_id,identity_key,proof)
    on conflict do nothing;
  select * into strict previous from public.libsignal_receive_attestations
    where user_id=new.user_id and device_id=new.device_id for update;
  -- Une autre identité nécessite une autre installation, jamais l'écrasement
  -- de la preuve utilisée pour les anciens messages.
  if previous.identity_key is distinct from identity_key or previous.device_number is distinct from new.device_number
    or previous.registration_id is distinct from new.registration_id
    or previous.proof->>'deviceSigningKey' is distinct from d.device_signing_key
    or previous.proof->>'devicePublicKey' is distinct from d.device_public_key
    or previous.proof->>'accountFingerprint' is distinct from k.fingerprint then
    raise exception 'AEGIS_LIBSIGNAL_IDENTITY_BINDING_INVALID';
  end if;
  return new;
end $$;
revoke all on function public.capture_libsignal_receive_attestation() from public,anon,authenticated;
create trigger capture_libsignal_receive_attestation after insert or update of bundle_signature,bundle_signing_key,public_bundle
  on public.device_libsignal_prekey_bundles for each row execute function public.capture_libsignal_receive_attestation();

-- Seules les preuves encore vérifiables sont adoptées. Aucun store privé ni
-- bundle non signé n'est régénéré pour combler un appareil ancien ou hors ligne.
update public.device_libsignal_prekey_bundles b set bundle_signature=b.bundle_signature
  from public.user_devices d where d.user_id=b.user_id and d.device_id=b.device_id
    and b.bundle_signature is not null and b.bundle_signing_key=d.device_signing_key
    and d.is_active and d.approval_status='approved' and d.binding_status='bound' and d.account_bound_at is not null
    and d.revoked_at is null and d.stale_at is null and d.crypto_invalid_at is null;

create index message_device_copies_receive_identity_idx
  on public.message_device_copies(recipient_user_id,sender_user_id,sender_device_id);

create function public.get_libsignal_receive_attestation(p_user_id uuid,p_device_id text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid uuid := auth.uid(); result jsonb;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.assert_current_messaging_client();
  perform public.assert_current_login_session_approved();
  -- Pas d'annuaire des correspondants : preuve disponible au propriétaire ou
  -- au destinataire réel d'une copie. Aucun test d'amitié ni de stock de préclés.
  if v_uid<>p_user_id and not exists(
    select 1 from public.message_device_copies c join public.messages m on m.id=c.message_id and m.sender_id=c.sender_user_id
    where c.recipient_user_id=v_uid and c.sender_user_id=p_user_id and c.sender_device_id=p_device_id
  ) then raise exception 'AEGIS_LIBSIGNAL_RECEIVE_PROOF_UNAVAILABLE'; end if;
  select a.proof into result from public.libsignal_receive_attestations a where a.user_id=p_user_id and a.device_id=p_device_id;
  if result is null then raise exception 'AEGIS_LIBSIGNAL_RECEIVE_PROOF_UNAVAILABLE'; end if;
  return result;
end $$;
revoke all on function public.get_libsignal_receive_attestation(uuid,text) from public,anon;
grant execute on function public.get_libsignal_receive_attestation(uuid,text) to authenticated;
commit;
