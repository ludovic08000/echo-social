create or replace function public.webauthn_finalize_device_recovery(
  p_user_id uuid,
  p_challenge_id uuid,
  p_credential_id text,
  p_new_sign_count bigint
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $fn$
declare
  v_challenge public.webauthn_device_challenges%rowtype;
  v_credential public.webauthn_device_credentials%rowtype;
  v_device public.user_devices%rowtype;
  v_vault public.webauthn_device_vaults%rowtype;
begin
  select * into v_challenge from public.webauthn_device_challenges where id = p_challenge_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_NOT_FOUND'); end if;
  if v_challenge.user_id <> p_user_id or v_challenge.purpose <> 'recover' then
    return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_MISMATCH');
  end if;
  if v_challenge.consumed_at is not null then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_USED'); end if;
  if v_challenge.expires_at <= now() then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_EXPIRED'); end if;

  select * into v_credential
  from public.webauthn_device_credentials
  where credential_id = p_credential_id and user_id = p_user_id and rp_id = v_challenge.rp_id
  for update;
  if not found or v_credential.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CREDENTIAL_NOT_FOUND');
  end if;

  if v_credential.sign_count > 0 and coalesce(p_new_sign_count,0) > 0 and p_new_sign_count <= v_credential.sign_count then
    return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_SIGN_COUNT_REPLAY');
  end if;

  select * into v_device
  from public.user_devices d
  where d.user_id = p_user_id and d.device_id = v_credential.device_id
  for update;
  if not found or v_device.approval_status <> 'approved' or v_device.binding_status <> 'bound'
     or v_device.lifecycle_status <> 'ready' or v_device.routing_status <> 'ready'
     or v_device.is_active <> true or v_device.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_READY');
  end if;
  if v_device.device_signing_key is null or v_device.device_public_key is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_KEYS_INCOMPLETE');
  end if;

  select * into v_vault from public.webauthn_device_vaults
  where user_id = p_user_id and device_id = v_credential.device_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_DEVICE_VAULT_NOT_FOUND'); end if;

  update public.webauthn_device_credentials
  set sign_count = greatest(sign_count, coalesce(p_new_sign_count,0)), last_used_at = now()
  where credential_id = p_credential_id;
  update public.webauthn_device_challenges set consumed_at = now() where id = p_challenge_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'WEBAUTHN_DEVICE_RECOVERED',
    'device_id', v_credential.device_id,
    'device_signing_key', v_device.device_signing_key,
    'device_public_key', v_device.device_public_key,
    'vault', jsonb_build_object('version', v_vault.version, 'iv', v_vault.iv, 'ciphertext', v_vault.ciphertext)
  );
end;
$fn$;

revoke all on function public.webauthn_finalize_device_recovery(uuid,uuid,text,bigint) from public, anon, authenticated;
grant execute on function public.webauthn_finalize_device_recovery(uuid,uuid,text,bigint) to service_role;
