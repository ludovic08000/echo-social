CREATE OR REPLACE FUNCTION public.aegis_resolve_conversation_route(
  p_conversation_id uuid,
  p_sender_device_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sender_device text := nullif(trim(coalesce(p_sender_device_id, '')), '');
  v_route_version text;
  v_participants jsonb;
  v_self_routable boolean := false;
begin
  -- Invariant : une seule lecture atomique de la route (version + appareils),
  -- pour supprimer la dérive entre deux appels séparés côté client.
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_conversation_id is null then
    raise exception 'conversation_required' using errcode = '23502';
  end if;
  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_uid
  ) then
    raise exception 'not_conversation_participant' using errcode = '42501';
  end if;

  v_route_version := public.get_aegis_conversation_route_version(p_conversation_id);

  select coalesce(jsonb_agg(participant_row order by participant_row->>'user_id'), '[]'::jsonb)
  into v_participants
  from (
    select jsonb_build_object(
      'user_id', peer.user_id,
      'is_self', peer.user_id = v_uid,
      'routable_count', coalesce(devices.routable_count, 0),
      'total_count', coalesce(devices.total_count, 0),
      'reason', case
        when coalesce(devices.total_count, 0) = 0 then 'NO_DEVICE_IDENTITY'
        when coalesce(devices.routable_count, 0) = 0 then 'DEVICES_NOT_ROUTABLE'
        else 'OK'
      end,
      'devices', coalesce(devices.devices, '[]'::jsonb)
    ) as participant_row
    from (
      select distinct cp.user_id
      from public.conversation_participants cp
      where cp.conversation_id = p_conversation_id
        and cp.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
    ) peer
    left join lateral (
      select
        count(*) as total_count,
        count(*) filter (where d.is_routable) as routable_count,
        jsonb_agg(
          jsonb_build_object(
            'device_id', d.device_id,
            'device_public_key', d.device_public_key,
            'device_signing_key', d.device_signing_key,
            'device_authorization_signature', d.device_authorization_signature,
            'last_seen_at', d.last_seen_at,
            'account_identity_key', d.account_identity_key,
            'account_signing_key', d.account_signing_key,
            'account_fingerprint', d.account_fingerprint,
            'account_binding_signature', d.account_binding_signature,
            'account_binding_version', d.account_binding_version,
            'is_routable', d.is_routable
          )
          order by d.device_id
        ) as devices
      from public.get_sesame_device_list(peer.user_id) d
    ) devices on true
  ) rows;

  if v_sender_device is not null then
    select exists (
      select 1
      from public.get_sesame_device_list(v_uid) own
      where own.device_id = v_sender_device
        and own.is_routable = true
    ) into v_self_routable;
  end if;

  return jsonb_build_object(
    'route_version', v_route_version,
    'self_user_id', v_uid,
    'sender_device_id', v_sender_device,
    'sender_device_routable', v_self_routable,
    'participants', v_participants
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.aegis_resolve_conversation_route(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.aegis_resolve_conversation_route(uuid, text) TO authenticated;