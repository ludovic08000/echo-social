-- Invariant corrigé : la version de route Aegis ne doit changer QUE si le
-- matériel de routage change réellement (clés, signatures, appareils).
-- Les republications identiques faisaient tourner la version pendant l'envoi,
-- rendant chaque message éternellement "E2EE_DEVICE_LIST_STALE".
create or replace function public.trg_bump_aegis_signature_route()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_ignored text[] := array['id', 'created_at', 'updated_at', 'signed_at', 'last_seen_at'];
begin
  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;

  if tg_op = 'UPDATE' then
    if (to_jsonb(old) - v_ignored) = (to_jsonb(new) - v_ignored) then
      return new;
    end if;
  end if;

  perform public.bump_aegis_user_route_version(v_user_id);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Invariant corrigé : le serveur doit voir la même version de route que le
-- client. Semer 1 dans la transaction d'envoi divergeait du calcul client
-- (absence de ligne = 0) et provoquait un faux "device list stale".
do $do$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid)
  into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'aegis_send_message';

  if v_def is null then
    raise exception 'aegis_send_message introuvable';
  end if;

  v_def := replace(
    v_def,
    'select participant.user_id, 1
  from public.conversation_participants participant',
    'select participant.user_id, 0
  from public.conversation_participants participant'
  );

  execute v_def;
end;
$do$;