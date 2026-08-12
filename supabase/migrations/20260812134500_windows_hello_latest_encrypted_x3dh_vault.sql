-- Windows Hello continues to authorize recovery, while the recovered payload
-- comes from the latest opaque device snapshot when one exists. Supabase never
-- receives the account Master Key or plaintext private X3DH material.

begin;

create or replace function public.webauthn_recover_device_vault_rpc(
  p_challenge_id uuid,
  p_credential_id text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_uid uuid:=auth.uid();
  v_ch public.webauthn_device_challenges%rowtype;
  v_cred public.webauthn_device_credentials%rowtype;
  v_vault public.webauthn_device_vaults%rowtype;
  v_cloud_vault jsonb;
  v_dev public.user_devices%rowtype;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_ch from public.webauthn_device_challenges
    where id=p_challenge_id and user_id=v_uid and purpose='recover' for update;
  if not found then raise exception 'WEBAUTHN_CHALLENGE_NOT_FOUND'; end if;
  if v_ch.consumed_at is not null then raise exception 'WEBAUTHN_CHALLENGE_USED'; end if;
  if v_ch.expires_at<=now() then raise exception 'WEBAUTHN_CHALLENGE_EXPIRED'; end if;

  select * into v_cred from public.webauthn_device_credentials
    where credential_id=p_credential_id and user_id=v_uid
      and rp_id=v_ch.rp_id and revoked_at is null;
  if not found then raise exception 'WEBAUTHN_CREDENTIAL_NOT_FOUND'; end if;

  select * into v_dev from public.user_devices
    where user_id=v_uid and device_id=v_cred.device_id;
  if not found or v_dev.approval_status<>'approved' or v_dev.binding_status<>'bound'
    or v_dev.lifecycle_status<>'ready' or v_dev.routing_status<>'ready'
    or v_dev.is_active is distinct from true or v_dev.revoked_at is not null
  then raise exception 'DEVICE_NOT_READY'; end if;

  select encrypted.vault into v_cloud_vault
  from public.device_encrypted_vaults encrypted
  where encrypted.user_id=v_uid
    and encrypted.device_id=v_cred.device_id
    and encrypted.platform='windows-hello';

  if v_cloud_vault is null then
    select * into v_vault from public.webauthn_device_vaults
      where user_id=v_uid and device_id=v_cred.device_id;
    if not found then raise exception 'WEBAUTHN_DEVICE_VAULT_NOT_FOUND'; end if;
    v_cloud_vault:=jsonb_build_object(
      'version',v_vault.version,'iv',v_vault.iv,'ciphertext',v_vault.ciphertext
    );
  end if;

  update public.webauthn_device_challenges set consumed_at=now() where id=p_challenge_id;
  update public.webauthn_device_credentials set last_used_at=now()
    where credential_id=p_credential_id;

  return jsonb_build_object(
    'ok',true,'code','WEBAUTHN_DEVICE_RECOVERED',
    'device_id',v_dev.device_id,'vault',v_cloud_vault,
    'device_signing_key',v_dev.device_signing_key,
    'device_public_key',v_dev.device_public_key
  );
end;
$$;

revoke all on function public.webauthn_recover_device_vault_rpc(uuid,text) from public,anon;
grant execute on function public.webauthn_recover_device_vault_rpc(uuid,text) to authenticated;

commit;
