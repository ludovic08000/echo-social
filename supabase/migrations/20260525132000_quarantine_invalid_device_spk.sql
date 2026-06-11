-- Quarantine cryptographically-invalid device SPKs for the current account.
--
-- The browser verifies Ed25519(SPK public key) with the active account signing
-- key. If that check fails for one of the authenticated user's own devices,
-- this RPC deactivates that device and its active/last-resort device SPKs so
-- other clients stop targeting it.

create or replace function public.quarantine_own_invalid_device_spk(
  p_device_id text,
  p_spk_id integer,
  p_reason text default 'invalid_device_spk_signature'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_device_updated integer := 0;
  v_spk_updated integer := 0;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if p_device_id is null or length(trim(p_device_id)) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
  end if;

  update public.device_signed_prekeys
  set is_active = false,
      is_last_resort = false
  where user_id = v_user
    and device_id = p_device_id
    and (spk_id = p_spk_id or is_active = true or is_last_resort = true);

  get diagnostics v_spk_updated = row_count;

  update public.user_devices
  set is_active = false,
      updated_at = now()
  where user_id = v_user
    and device_id = p_device_id
    and is_active = true;

  get diagnostics v_device_updated = row_count;

  return jsonb_build_object(
    'ok', true,
    'code', 'OWN_INVALID_DEVICE_QUARANTINED',
    'device_id', p_device_id,
    'spk_id', p_spk_id,
    'reason', left(coalesce(p_reason, 'invalid_device_spk_signature'), 200),
    'devices_deactivated', v_device_updated,
    'spks_deactivated', v_spk_updated
  );
end;
$$;

grant execute on function public.quarantine_own_invalid_device_spk(text, integer, text) to authenticated;
