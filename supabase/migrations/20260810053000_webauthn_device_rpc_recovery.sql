-- Windows Hello / WebAuthn device recovery without a deployable Edge Function.
-- Security model: registration is authenticated and signed by the already-ready
-- device Ed25519 key. Recovery releases only the AES-GCM encrypted device vault;
-- the account Master Key is still required client-side to decrypt it.

create or replace function public.webauthn_begin_device_registration(p_device_id text, p_origin text, p_rp_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_challenge text; v_id uuid; v_email text; v_existing jsonb;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_device_id !~ '^dev_[a-f0-9]{32}$' then raise exception 'DEVICE_INVALID_ID'; end if;
  if p_origin not in ('https://forsure.fans','https://www.forsure.fans') and p_origin !~ '^https://[a-z0-9-]+\.lovable\.app$' then raise exception 'WEBAUTHN_ORIGIN_DENIED'; end if;
  if p_rp_id <> split_part(replace(p_origin,'https://',''),'/',1) then raise exception 'WEBAUTHN_RP_ID_INVALID'; end if;
  if not exists (select 1 from public.user_devices d where d.user_id=v_uid and d.device_id=p_device_id and d.approval_status='approved' and d.binding_status='bound' and d.lifecycle_status='ready' and d.routing_status='ready' and d.is_active=true and d.revoked_at is null) then raise exception 'DEVICE_NOT_READY'; end if;
  v_challenge := rtrim(translate(encode(gen_random_bytes(32),'base64'), '+/', '-_'), '=');
  insert into public.webauthn_device_challenges(user_id,device_id,purpose,challenge,rp_id,origin,expires_at)
  values(v_uid,p_device_id,'register',v_challenge,p_rp_id,p_origin,now()+interval '5 minutes') returning id into v_id;
  select email into v_email from auth.users where id=v_uid;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.credential_id,'transports',c.transports)),'[]'::jsonb) into v_existing
    from public.webauthn_device_credentials c where c.user_id=v_uid and c.device_id=p_device_id and c.rp_id=p_rp_id and c.revoked_at is null;
  return jsonb_build_object('ok',true,'challengeId',v_id,'challenge',v_challenge,'rpId',p_rp_id,'origin',p_origin,'userId',v_uid,'email',coalesce(v_email,v_uid::text),'excludeCredentials',v_existing);
end;$$;

create or replace function public.webauthn_finalize_device_registration_rpc(
  p_device_id text,p_challenge_id uuid,p_credential_id text,p_rp_id text,p_public_key_spki text,
  p_algorithm integer,p_sign_count bigint,p_transports text[],p_vault_version integer,p_vault_iv text,
  p_vault_ciphertext text,p_device_proof_b64 text,p_proof_payload text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_ch public.webauthn_device_challenges%rowtype; v_dev public.user_devices%rowtype; v_json jsonb;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_ch from public.webauthn_device_challenges where id=p_challenge_id and user_id=v_uid and purpose='register' for update;
  if not found then raise exception 'WEBAUTHN_CHALLENGE_NOT_FOUND'; end if;
  if v_ch.consumed_at is not null then raise exception 'WEBAUTHN_CHALLENGE_USED'; end if;
  if v_ch.expires_at <= now() then raise exception 'WEBAUTHN_CHALLENGE_EXPIRED'; end if;
  if v_ch.device_id <> p_device_id or v_ch.rp_id <> p_rp_id then raise exception 'WEBAUTHN_CHALLENGE_MISMATCH'; end if;
  select * into v_dev from public.user_devices where user_id=v_uid and device_id=p_device_id;
  if not found or v_dev.approval_status<>'approved' or v_dev.binding_status<>'bound' or v_dev.lifecycle_status<>'ready' or v_dev.routing_status<>'ready' or v_dev.is_active is distinct from true or v_dev.revoked_at is not null then raise exception 'DEVICE_NOT_READY'; end if;
  if p_credential_id !~ '^[A-Za-z0-9_-]{16,1024}$' or p_algorithm <> -7 or p_sign_count < 0 then raise exception 'WEBAUTHN_CREDENTIAL_INVALID'; end if;
  if p_vault_version <> 1 or length(p_vault_iv) < 16 or length(p_vault_ciphertext) < 64 then raise exception 'WEBAUTHN_DEVICE_VAULT_INVALID'; end if;
  begin v_json := p_proof_payload::jsonb; exception when others then raise exception 'WEBAUTHN_PROOF_PAYLOAD_INVALID'; end;
  if v_json->>'protocol' <> 'forsure-webauthn-device-registration' or (v_json->>'version')::int <> 1 or v_json->>'userId' <> v_uid::text or v_json->>'deviceId' <> p_device_id or v_json->>'challengeId' <> p_challenge_id::text or v_json->>'challenge' <> v_ch.challenge or v_json->>'credentialId' <> p_credential_id or v_json->>'rpId' <> p_rp_id or coalesce(v_json->>'publicKeySha256','')='' or coalesce(v_json->>'vaultSha256','')='' then raise exception 'WEBAUTHN_PROOF_PAYLOAD_MISMATCH'; end if;
  if not aegis_private.verify_ed25519_b64(v_dev.device_signing_key,p_device_proof_b64,p_proof_payload) then raise exception 'WEBAUTHN_DEVICE_PROOF_INVALID'; end if;
  insert into public.webauthn_device_credentials(credential_id,user_id,device_id,rp_id,public_key_spki,algorithm,sign_count,transports,created_at,last_used_at,revoked_at)
  values(p_credential_id,v_uid,p_device_id,p_rp_id,p_public_key_spki,p_algorithm,p_sign_count,coalesce(p_transports,'{}'::text[]),now(),null,null)
  on conflict (credential_id) do update set user_id=excluded.user_id,device_id=excluded.device_id,rp_id=excluded.rp_id,public_key_spki=excluded.public_key_spki,algorithm=excluded.algorithm,sign_count=excluded.sign_count,transports=excluded.transports,revoked_at=null;
  insert into public.webauthn_device_vaults(user_id,device_id,version,iv,ciphertext,created_at,updated_at)
  values(v_uid,p_device_id,p_vault_version,p_vault_iv,p_vault_ciphertext,now(),now())
  on conflict (user_id,device_id) do update set version=excluded.version,iv=excluded.iv,ciphertext=excluded.ciphertext,updated_at=now();
  update public.webauthn_device_challenges set consumed_at=now() where id=p_challenge_id;
  return jsonb_build_object('ok',true,'code','WEBAUTHN_DEVICE_REGISTERED','device_id',p_device_id,'credential_id',p_credential_id);
end;$$;

create or replace function public.webauthn_device_status(p_device_id text,p_rp_id text)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
select jsonb_build_object('ok',true,'registered',exists(select 1 from public.webauthn_device_credentials c join public.user_devices d on d.user_id=c.user_id and d.device_id=c.device_id where c.user_id=auth.uid() and c.device_id=p_device_id and c.rp_id=p_rp_id and c.revoked_at is null and d.approval_status='approved' and d.binding_status='bound' and d.lifecycle_status='ready' and d.routing_status='ready' and d.is_active=true and d.revoked_at is null));
$$;

create or replace function public.webauthn_begin_device_recovery(p_origin text,p_rp_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=auth.uid(); v_challenge text; v_id uuid; v_creds jsonb;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_origin not in ('https://forsure.fans','https://www.forsure.fans') and p_origin !~ '^https://[a-z0-9-]+\.lovable\.app$' then raise exception 'WEBAUTHN_ORIGIN_DENIED'; end if;
  if p_rp_id <> split_part(replace(p_origin,'https://',''),'/',1) then raise exception 'WEBAUTHN_RP_ID_INVALID'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.credential_id,'deviceId',c.device_id,'transports',c.transports)),'[]'::jsonb) into v_creds
    from public.webauthn_device_credentials c join public.user_devices d on d.user_id=c.user_id and d.device_id=c.device_id
    where c.user_id=v_uid and c.rp_id=p_rp_id and c.revoked_at is null and d.approval_status='approved' and d.binding_status='bound' and d.lifecycle_status='ready' and d.routing_status='ready' and d.is_active=true and d.revoked_at is null;
  if jsonb_array_length(v_creds)=0 then raise exception 'WEBAUTHN_RECOVERY_NOT_CONFIGURED'; end if;
  v_challenge:=rtrim(translate(encode(gen_random_bytes(32),'base64'), '+/', '-_'), '=');
  insert into public.webauthn_device_challenges(user_id,purpose,challenge,rp_id,origin,expires_at) values(v_uid,'recover',v_challenge,p_rp_id,p_origin,now()+interval '5 minutes') returning id into v_id;
  return jsonb_build_object('ok',true,'challengeId',v_id,'challenge',v_challenge,'rpId',p_rp_id,'origin',p_origin,'allowCredentials',v_creds);
end;$$;

create or replace function public.webauthn_recover_device_vault_rpc(p_challenge_id uuid,p_credential_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=auth.uid(); v_ch public.webauthn_device_challenges%rowtype; v_cred public.webauthn_device_credentials%rowtype; v_vault public.webauthn_device_vaults%rowtype; v_dev public.user_devices%rowtype;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_ch from public.webauthn_device_challenges where id=p_challenge_id and user_id=v_uid and purpose='recover' for update;
  if not found then raise exception 'WEBAUTHN_CHALLENGE_NOT_FOUND'; end if;
  if v_ch.consumed_at is not null then raise exception 'WEBAUTHN_CHALLENGE_USED'; end if;
  if v_ch.expires_at<=now() then raise exception 'WEBAUTHN_CHALLENGE_EXPIRED'; end if;
  select * into v_cred from public.webauthn_device_credentials where credential_id=p_credential_id and user_id=v_uid and rp_id=v_ch.rp_id and revoked_at is null;
  if not found then raise exception 'WEBAUTHN_CREDENTIAL_NOT_FOUND'; end if;
  select * into v_dev from public.user_devices where user_id=v_uid and device_id=v_cred.device_id;
  if not found or v_dev.approval_status<>'approved' or v_dev.binding_status<>'bound' or v_dev.lifecycle_status<>'ready' or v_dev.routing_status<>'ready' or v_dev.is_active is distinct from true or v_dev.revoked_at is not null then raise exception 'DEVICE_NOT_READY'; end if;
  select * into v_vault from public.webauthn_device_vaults where user_id=v_uid and device_id=v_cred.device_id;
  if not found then raise exception 'WEBAUTHN_DEVICE_VAULT_NOT_FOUND'; end if;
  update public.webauthn_device_challenges set consumed_at=now() where id=p_challenge_id;
  update public.webauthn_device_credentials set last_used_at=now() where credential_id=p_credential_id;
  return jsonb_build_object('ok',true,'code','WEBAUTHN_DEVICE_RECOVERED','device_id',v_dev.device_id,'vault',jsonb_build_object('version',v_vault.version,'iv',v_vault.iv,'ciphertext',v_vault.ciphertext),'device_signing_key',v_dev.device_signing_key,'device_public_key',v_dev.device_public_key);
end;$$;

grant execute on function public.webauthn_begin_device_registration(text,text,text) to authenticated;
grant execute on function public.webauthn_finalize_device_registration_rpc(text,uuid,text,text,text,integer,bigint,text[],integer,text,text,text,text) to authenticated;
grant execute on function public.webauthn_device_status(text,text) to authenticated;
grant execute on function public.webauthn_begin_device_recovery(text,text) to authenticated;
grant execute on function public.webauthn_recover_device_vault_rpc(uuid,text) to authenticated;
