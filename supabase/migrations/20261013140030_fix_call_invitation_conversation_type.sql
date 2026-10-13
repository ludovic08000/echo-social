begin;
set local lock_timeout='3s';
set local statement_timeout='15s';

-- active_calls conserve son schéma historique text. Le RPC accepte déjà un UUID :
-- conversion explicite au point de vérification, sans changer les octets signés,
-- les clés, les autorisations ni les données existantes.
do $$
declare
  definition text := pg_get_functiondef('public.authenticate_aegis_call_invitation()'::regprocedure);
  old_call text := 'v_call.id,v_call.conversation_id,v_call.caller_id';
  new_call text := 'v_call.id,v_call.conversation_id::uuid,v_call.caller_id';
begin
  if position(new_call in definition)>0 then return; end if;
  if position(old_call in definition)=0 then
    raise exception 'CALL_INVITATION_TRIGGER_DEFINITION_UNEXPECTED';
  end if;
  execute replace(definition,old_call,new_call);
end $$;
commit;
