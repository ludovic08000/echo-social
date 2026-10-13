begin;
set local lock_timeout='3s';
do $$
declare
  definition text := pg_get_functiondef('public.authenticate_aegis_call_invitation()'::regprocedure);
begin
  if position('v_call.id,v_call.conversation_id::uuid,v_call.caller_id' in definition)=0 then
    raise exception 'CALL_INVITATION_TRIGGER_DEFINITION_UNEXPECTED';
  end if;
  execute replace(definition,'v_call.id,v_call.conversation_id::uuid,v_call.caller_id',
    'v_call.id,v_call.conversation_id,v_call.caller_id');
end $$;
commit;
