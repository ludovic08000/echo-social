begin;
create table public.libsignal_device_bundles (
 user_id uuid not null, device_id text not null,
 signal_device_id integer not null check(signal_device_id>0), registration_id integer not null check(registration_id>0),
 identity_key_b64 text not null, signed_prekey_id integer not null, signed_prekey_b64 text not null, signed_prekey_signature_b64 text not null,
 kyber_prekey_id integer not null, kyber_prekey_b64 text not null, kyber_prekey_signature_b64 text not null,
 one_time_prekey_id integer, one_time_prekey_b64 text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(user_id,device_id), foreign key(user_id,device_id) references public.user_devices(user_id,device_id) on delete cascade
);
alter table public.libsignal_device_bundles enable row level security;
revoke all on public.libsignal_device_bundles from anon,authenticated;

create function public.publish_libsignal_device_bundle(p_device_id text,p_bundle jsonb) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); begin
 if u is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
 if not exists(select 1 from public.user_devices d where d.user_id=u and d.device_id=p_device_id and d.is_active and d.approval_status='approved' and d.revoked_at is null) then raise exception 'DEVICE_NOT_APPROVED' using errcode='42501'; end if;
 insert into public.libsignal_device_bundles(user_id,device_id,signal_device_id,registration_id,identity_key_b64,signed_prekey_id,signed_prekey_b64,signed_prekey_signature_b64,kyber_prekey_id,kyber_prekey_b64,kyber_prekey_signature_b64,one_time_prekey_id,one_time_prekey_b64)
 values(u,p_device_id,(p_bundle->>'signalDeviceId')::int,(p_bundle->>'registrationId')::int,p_bundle->>'identityKeyB64',(p_bundle->>'signedPreKeyId')::int,p_bundle->>'signedPreKeyB64',p_bundle->>'signedPreKeySignatureB64',(p_bundle->>'kyberPreKeyId')::int,p_bundle->>'kyberPreKeyB64',p_bundle->>'kyberPreKeySignatureB64',nullif(p_bundle->>'oneTimePreKeyId','')::int,p_bundle->>'oneTimePreKeyB64')
 on conflict(user_id,device_id) do update set signal_device_id=excluded.signal_device_id,registration_id=excluded.registration_id,identity_key_b64=excluded.identity_key_b64,signed_prekey_id=excluded.signed_prekey_id,signed_prekey_b64=excluded.signed_prekey_b64,signed_prekey_signature_b64=excluded.signed_prekey_signature_b64,kyber_prekey_id=excluded.kyber_prekey_id,kyber_prekey_b64=excluded.kyber_prekey_b64,kyber_prekey_signature_b64=excluded.kyber_prekey_signature_b64,one_time_prekey_id=excluded.one_time_prekey_id,one_time_prekey_b64=excluded.one_time_prekey_b64,updated_at=now();
end $$;

create function public.claim_libsignal_device_bundle(p_user_id uuid,p_device_id text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.libsignal_device_bundles%rowtype; begin
 if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
 select x.* into b from public.libsignal_device_bundles x join public.user_devices d using(user_id,device_id) where x.user_id=p_user_id and x.device_id=p_device_id and d.is_active and d.approval_status='approved' and d.revoked_at is null for update of x;
 if not found then raise exception 'LIBSIGNAL_BUNDLE_UNAVAILABLE' using errcode='P0002'; end if;
 update public.libsignal_device_bundles set one_time_prekey_id=null,one_time_prekey_b64=null,updated_at=now() where user_id=p_user_id and device_id=p_device_id;
 return jsonb_build_object('signalDeviceId',b.signal_device_id,'registrationId',b.registration_id,'identityKeyB64',b.identity_key_b64,'signedPreKeyId',b.signed_prekey_id,'signedPreKeyB64',b.signed_prekey_b64,'signedPreKeySignatureB64',b.signed_prekey_signature_b64,'kyberPreKeyId',b.kyber_prekey_id,'kyberPreKeyB64',b.kyber_prekey_b64,'kyberPreKeySignatureB64',b.kyber_prekey_signature_b64,'oneTimePreKeyId',b.one_time_prekey_id,'oneTimePreKeyB64',b.one_time_prekey_b64);
end $$;
revoke all on function public.publish_libsignal_device_bundle(text,jsonb) from public;
revoke all on function public.claim_libsignal_device_bundle(uuid,text) from public;
grant execute on function public.publish_libsignal_device_bundle(text,jsonb) to authenticated;
grant execute on function public.claim_libsignal_device_bundle(uuid,text) to authenticated;
commit;
