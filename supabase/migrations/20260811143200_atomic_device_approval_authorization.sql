-- Trusted-device approval must atomically authorize the target device with the
-- account signing key. A secondary device can no longer become approved first
-- and receive its account authorization in a later, independent transition.
--
-- Flow for a trusted secondary approval:
--   trusted approver decision signature
--     -> account -> target device authorization signature
--     -> server verifies both
--     -> approved + account-bound in one transaction
--
-- Primary bootstrap remains on the existing bootstrap path because no prior
-- trusted device exists yet. Reject decisions never require account binding.

begin;

alter function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text)
  rename to approve_device_enrollment_decision_pre_account_authorization;

revoke all on function public.approve_device_enrollment_decision_pre_account_authorization(text,boolean,text,text,uuid,text)
  from public, anon, authenticated, service_role;

create function public.approve_device_enrollment_decision(
  p_decision text,
  p_bootstrap_primary boolean,
  p_approver_device_id text,
  p_device_id text,
  p_challenge_id uuid,
  p_signature text,
  p_device_authorization_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device public.user_devices%rowtype;
  v_account public.user_public_keys%rowtype;
  v_result jsonb;
  v_binding jsonb;
  v_binding_code text;
  v_requires_account_authorization boolean :=
    p_decision = 'approve' and p_bootstrap_primary is false;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if v_requires_account_authorization then
    if length(trim(coalesce(p_device_authorization_signature, ''))) < 80 then
      return jsonb_build_object(
        'ok', false,
        'code', 'DEVICE_AUTHORIZATION_SIGNATURE_REQUIRED'
      );
    end if;

    -- Serialize every approval/binding transition for this account. The legacy
    -- approval function takes the same advisory lock, which is re-entrant in
    -- this transaction.
    perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

    select * into v_device
    from public.user_devices d
    where d.user_id = v_uid and d.device_id = trim(p_device_id)
    for update;

    if not found then
      return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
    end if;
    if v_device.approval_status <> 'pending'
       or v_device.is_active <> false
       or v_device.revoked_at is not null then
      return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_PENDING');
    end if;
    if v_device.device_public_key is null or v_device.device_signing_key is null then
      return jsonb_build_object('ok', false, 'code', 'DEVICE_PUBLIC_KEYS_MISSING');
    end if;

    -- The device doing the approving must itself still be cryptographically
    -- routable, not merely marked ready in administrative columns.
    if not exists (
      select 1
      from public.get_sesame_device_list(v_uid) s
      where s.device_id = trim(p_approver_device_id)
        and s.is_routable = true
    ) then
      return jsonb_build_object(
        'ok', false,
        'code', 'APPROVER_DEVICE_CRYPTO_TRUST_INVALID'
      );
    end if;

    select * into v_account
    from public.user_public_keys k
    where k.user_id = v_uid and k.is_active = true
    order by k.created_at desc
    limit 1
    for update;

    if not found then
      return jsonb_build_object('ok', false, 'code', 'ACCOUNT_IDENTITY_NOT_FOUND');
    end if;

    if not public.aegis_verify_account_binding(
      v_account.identity_key,
      v_account.signing_key,
      v_account.fingerprint,
      v_account.identity_binding_signature,
      v_account.identity_binding_version
    ) then
      return jsonb_build_object(
        'ok', false,
        'code', 'ACCOUNT_BINDING_SIGNATURE_INVALID'
      );
    end if;

    if not public.aegis_verify_device_authorization(
      v_uid,
      trim(p_device_id),
      v_device.device_public_key,
      v_device.device_signing_key,
      trim(p_device_authorization_signature),
      v_account.signing_key,
      v_account.fingerprint
    ) then
      return jsonb_build_object(
        'ok', false,
        'code', 'DEVICE_AUTHORIZATION_SIGNATURE_INVALID'
      );
    end if;
  end if;

  -- Keep approval and account binding inside a PL/pgSQL subtransaction. If the
  -- binding unexpectedly fails after approval, raising inside this block rolls
  -- the approval mutation back before we return a structured error.
  begin
    v_result := public.approve_device_enrollment_decision_pre_account_authorization(
      p_decision,
      p_bootstrap_primary,
      p_approver_device_id,
      p_device_id,
      p_challenge_id,
      p_signature
    );

    if v_result is null or coalesce((v_result ->> 'ok')::boolean, false) is not true then
      return coalesce(
        v_result,
        jsonb_build_object('ok', false, 'code', 'DEVICE_APPROVAL_REJECTED')
      );
    end if;

    if v_requires_account_authorization then
      v_binding := public.finalize_device_account_binding(
        v_uid,
        trim(p_device_id),
        trim(p_device_authorization_signature)
      );

      if v_binding is null or coalesce((v_binding ->> 'ok')::boolean, false) is not true then
        v_binding_code := coalesce(v_binding ->> 'code', 'DEVICE_ACCOUNT_BINDING_FAILED');
        raise exception 'ATOMIC_DEVICE_APPROVAL_BINDING_FAILED:%', v_binding_code;
      end if;

      v_result := v_result || jsonb_build_object(
        'binding_status', 'bound',
        'account_authorized', true
      );
    end if;
  exception when others then
    if sqlerrm like 'ATOMIC_DEVICE_APPROVAL_BINDING_FAILED:%' then
      return jsonb_build_object(
        'ok', false,
        'code', split_part(sqlerrm, ':', 2),
        'approval_rolled_back', true
      );
    end if;
    raise;
  end;

  return v_result;
end;
$$;

-- Compatibility overload: older clients may still call the six-argument RPC.
-- They can reject and bootstrap the first primary, but a trusted secondary
-- approval fails closed until the account authorization signature is supplied.
create function public.approve_device_enrollment_decision(
  p_decision text,
  p_bootstrap_primary boolean,
  p_approver_device_id text,
  p_device_id text,
  p_challenge_id uuid,
  p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_decision = 'approve' and p_bootstrap_primary is false then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_AUTHORIZATION_SIGNATURE_REQUIRED'
    );
  end if;

  return public.approve_device_enrollment_decision(
    p_decision,
    p_bootstrap_primary,
    p_approver_device_id,
    p_device_id,
    p_challenge_id,
    p_signature,
    null
  );
end;
$$;

revoke all on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text,text)
  from public, anon;
revoke all on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text)
  from public, anon;
grant execute on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text,text)
  to authenticated, service_role;
grant execute on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text)
  to authenticated, service_role;

commit;
