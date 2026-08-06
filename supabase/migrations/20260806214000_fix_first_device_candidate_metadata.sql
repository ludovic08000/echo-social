-- `FOUND` changes after every PL/pgSQL statement. The previous candidate RPC
-- used `not found` in its final JSON response after several UPDATE statements,
-- so the informational `first_device_candidate` flag did not reliably describe
-- whether an account identity existed before enrollment.
--
-- Keep the verified implementation intact and expose a thin wrapper that takes
-- the immutable account-state snapshot before executing it.

begin;

alter function public.complete_user_device_enrollment_candidate(
  uuid,text,text,text,text,text
) rename to complete_user_device_enrollment_candidate_verified;

revoke all on function public.complete_user_device_enrollment_candidate_verified(
  uuid,text,text,text,text,text
) from public, anon, authenticated, service_role;

create or replace function public.complete_user_device_enrollment_candidate(
  p_challenge_id uuid,
  p_nonce text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_possession_signature text,
  p_account_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_account_existed boolean := false;
  v_result jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  select exists (
    select 1
    from public.user_public_keys account
    where account.user_id = v_uid
      and account.is_active = true
  ) into v_account_existed;

  v_result := public.complete_user_device_enrollment_candidate_verified(
    p_challenge_id,
    p_nonce,
    p_device_public_key,
    p_device_signing_key,
    p_device_possession_signature,
    p_account_fingerprint
  );

  if coalesce((v_result ->> 'ok')::boolean, false) is true
     and v_result ->> 'code' in (
       'DEVICE_ENROLLMENT_COMPLETED',
       'DEVICE_ENROLLMENT_ALREADY_COMPLETED'
     ) then
    return v_result || jsonb_build_object(
      'first_device_candidate', not v_account_existed
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.complete_user_device_enrollment_candidate(
  uuid,text,text,text,text,text
) from public, anon;
grant execute on function public.complete_user_device_enrollment_candidate(
  uuid,text,text,text,text,text
) to authenticated;

comment on function public.complete_user_device_enrollment_candidate(
  uuid,text,text,text,text,text
) is 'Stages a pending device and reports first-device status from the pre-enrollment account snapshot.';

notify pgrst, 'reload schema';

commit;
