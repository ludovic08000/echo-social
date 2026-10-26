set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- La creation d'appel doit attendre exactement le meme ensemble d'appareils
-- que le client. list_active_devices_for_user et le client utilisent deja la
-- liste Sesame attestee ; l'ancien RPC recompait aussi des routes repairing.
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.aegis_call_create(uuid,uuid,text,text,uuid[],jsonb)'::regprocedure
  );
  old_caller text := $old$
    select 1 from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = p_caller_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
      and nullif(trim(device.device_authorization_signature), '') is not null
  $old$;
  new_caller text := $new$
    select 1 from public.get_sesame_device_list(v_uid) route
    where route.device_id = p_caller_device_id
      and route.is_routable = true
  $new$;
  old_expected text := $old$
    select device.user_id, device.device_id
    from public.user_devices device
    where device.user_id = any(v_invitees)
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
  $old$;
  new_expected text := $new$
    select invitee.user_id, route.device_id
    from unnest(v_invitees) as invitee(user_id)
    cross join lateral public.get_sesame_device_list(invitee.user_id) route
    where route.is_routable = true
  $new$;
  old_expected_nested text;
  new_expected_nested text;
  previous_definition text;
begin
  definition := replace(definition, E'\r\n', E'\n');
  if definition like '%public.get_sesame_device_list(v_uid)%'
    and definition like '%cross join lateral public.get_sesame_device_list(invitee.user_id)%' then
    return;
  end if;

  previous_definition := definition;
  definition := replace(definition, old_caller, new_caller);
  if definition = previous_definition then
    raise exception 'AEGIS_CALL_CREATE_CALLER_DEFINITION_UNEXPECTED';
  end if;

  previous_definition := definition;
  old_expected_nested := replace(old_expected, E'\n    ', E'\n      ');
  new_expected_nested := replace(new_expected, E'\n    ', E'\n      ');
  definition := replace(definition, old_expected, new_expected);
  definition := replace(definition, old_expected_nested, new_expected_nested);
  if definition = previous_definition
    or definition not like '%get_sesame_device_list(invitee.user_id)%'
    or definition like '%select device.user_id, device.device_id%device.user_id = ANY (v_invitees)%' then
    raise exception 'AEGIS_CALL_CREATE_EXPECTED_DEFINITION_UNEXPECTED';
  end if;
  execute definition;
end
$migration$;

notify pgrst, 'reload schema';