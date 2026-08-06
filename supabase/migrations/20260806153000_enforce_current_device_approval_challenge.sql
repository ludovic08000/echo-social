-- Final defense-in-depth guard for explicit device approval.
-- The proof verifier already binds approval to one challenge; this wrapper also
-- requires that exact challenge to still be valid at finalization time.

begin;

alter function public.finalize_verified_user_device_approval(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) rename to finalize_verified_user_device_approval_verified_proofs;

revoke all on function public.finalize_verified_user_device_approval_verified_proofs(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) from public, anon, authenticated, service_role;

create or replace function public.finalize_verified_user_device_approval(
  p_user_id uuid,
  p_challenge_id uuid,
  p_device_id text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_authorization_signature text,
  p_device_possession_signature text,
  p_account_identity_key text,
  p_account_signing_key text,
  p_account_fingerprint text,
  p_account_binding_signature text,
  p_account_binding_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_challenge public.device_enrollment_challenges%rowtype;
  v_now timestamptz := now();
begin
  if p_user_id is null
     or p_challenge_id is null
     or trim(coalesce(p_device_id, '')) !~ '^dev_[a-f0-9]{32}$'
     or length(trim(coalesce(p_device_possession_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_APPROVAL_INPUT');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_challenge
  from public.device_enrollment_challenges challenge
  where challenge.id = p_challenge_id
    and challenge.user_id = p_user_id
    and challenge.device_id = trim(p_device_id)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_APPROVAL_CHALLENGE_NOT_FOUND');
  end if;
  if v_challenge.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CANCELLED');
  end if;
  if v_challenge.consumed_at is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_NOT_COMPLETED');
  end if;
  if v_challenge.expires_at <= v_now
     or v_challenge.consumed_at > v_challenge.expires_at then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_EXPIRED');
  end if;
  if v_challenge.possession_payload_version is distinct from 1
     or v_challenge.device_possession_signature is distinct from trim(p_device_possession_signature) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_POSSESSION_PROOF_CHANGED');
  end if;

  return public.finalize_verified_user_device_approval_verified_proofs(
    p_user_id,
    p_challenge_id,
    trim(p_device_id),
    p_device_public_key,
    p_device_signing_key,
    p_device_authorization_signature,
    p_device_possession_signature,
    p_account_identity_key,
    p_account_signing_key,
    p_account_fingerprint,
    p_account_binding_signature,
    p_account_binding_version
  );
end;
$$;

revoke all on function public.finalize_verified_user_device_approval(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) from public, anon, authenticated;
grant execute on function public.finalize_verified_user_device_approval(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) to service_role;

notify pgrst, 'reload schema';

commit;
