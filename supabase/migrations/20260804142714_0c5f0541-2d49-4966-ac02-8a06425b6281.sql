-- Invariant corrigé : le trigger de pinning appelait public.get_signed_device_list(),
-- supprimée lors du rebuild Aegis, ce qui faisait échouer 100% des envois.
-- On repasse sur la source de vérité unique : get_sesame_device_list(), filtrée sur is_routable.
create or replace function public.trg_aegis_require_pinned_device_copies()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sender_device_id text;
  v_current_route_version text;
  v_missing_count integer := 0;
  v_unexpected_count integer := 0;
  v_duplicate_count integer := 0;
begin
  if new.body_kind <> 'multi_device' then
    return null;
  end if;

  v_current_route_version :=
    public.get_aegis_conversation_route_version(new.conversation_id);
  if new.aegis_route_version is null
     or new.aegis_route_version is distinct from v_current_route_version then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = 'Aegis parent is not pinned to the current route version.';
  end if;

  select min(copy.sender_device_id)
  into v_sender_device_id
  from public.message_device_copies copy
  where copy.message_id = new.id
    and copy.sender_user_id = new.sender_id;

  if v_sender_device_id is null or length(trim(v_sender_device_id)) < 8 then
    raise exception 'E2EE_DEVICE_COPIES_UNAVAILABLE'
      using errcode = '23514',
            detail = 'Aegis parent has no sender-bound device copy set.';
  end if;

  select count(*) - count(distinct (copy.recipient_user_id, copy.recipient_device_id))
  into v_duplicate_count
  from public.message_device_copies copy
  where copy.message_id = new.id;

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral public.get_sesame_device_list(participant.user_id) device
    where participant.conversation_id = new.conversation_id
      and device.is_routable
      and not (
        participant.user_id = new.sender_id
        and device.device_id = v_sender_device_id
      )
  )
  select count(*)
  into v_missing_count
  from expected route
  where not exists (
    select 1
    from public.message_device_copies actual
    where actual.message_id = new.id
      and actual.recipient_user_id = route.recipient_user_id
      and actual.recipient_device_id = route.recipient_device_id
      and actual.sender_user_id = new.sender_id
      and actual.sender_device_id = v_sender_device_id
  );

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral public.get_sesame_device_list(participant.user_id) device
    where participant.conversation_id = new.conversation_id
      and device.is_routable
      and not (
        participant.user_id = new.sender_id
        and device.device_id = v_sender_device_id
      )
  )
  select count(*)
  into v_unexpected_count
  from public.message_device_copies actual
  where actual.message_id = new.id
    and (
      actual.sender_user_id <> new.sender_id
      or actual.sender_device_id <> v_sender_device_id
      or not exists (
        select 1
        from expected route
        where route.recipient_user_id = actual.recipient_user_id
          and route.recipient_device_id = actual.recipient_device_id
      )
    );

  if v_missing_count > 0
     or v_unexpected_count > 0
     or v_duplicate_count > 0 then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Pinned Aegis route mismatch: %s missing, %s unexpected, %s duplicate.',
              v_missing_count,
              v_unexpected_count,
              v_duplicate_count
            );
  end if;
  return null;
end;
$function$;