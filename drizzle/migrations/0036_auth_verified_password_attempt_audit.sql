
-- Ce hook reçoit le résultat natif d'Auth. Aucune déclaration de navigateur,
-- aucun mot de passe, e-mail, IP ou décision d'appareil ne traverse le journal.
create function aegis_observability.password_verification_attempt(event jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_user uuid;v_valid boolean;
begin
  if jsonb_typeof(event) is distinct from 'object' or jsonb_typeof(event->'valid') is distinct from 'boolean'
    or coalesce(event->>'user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return jsonb_build_object('decision','continue');end if;
  v_user:=(event->>'user_id')::uuid;v_valid:=(event->>'valid')::boolean;
  if not exists(select 1 from auth.users where id=v_user) then return jsonb_build_object('decision','continue');end if;
  if v_valid or (select count(*) from aegis_observability.journey_events where user_id=v_user
    and source='auth_password_verification' and outcome='failure' and occurred_at>now()-interval '1 minute')<120 then
    insert into aegis_observability.journey_events(user_id,stage,outcome,source,evidence)
      values(v_user,case when v_valid then 'auth_password_verified' else 'auth_password_rejected' end,
        case when v_valid then 'success' else 'failure' end,'auth_password_verification','server');
  end if;
  -- Un mot de passe juste reste accepté même après les échecs provoqués par un tiers.
  -- Auth garde son propre rate limiting ; ce hook n'approuve ni connexion ni appareil.
  return jsonb_build_object('decision','continue');
exception when others then
  raise log 'AUTH_PASSWORD_AUDIT_UNAVAILABLE sqlstate=%',sqlstate;
  return jsonb_build_object('decision','continue');
end $$;
revoke all on function aegis_observability.password_verification_attempt(jsonb) from public,anon,authenticated,service_role;
grant usage on schema aegis_observability,public to supabase_auth_admin;
grant execute on function aegis_observability.password_verification_attempt(jsonb) to supabase_auth_admin;
grant select(user_id,source,occurred_at,outcome),insert(user_id,stage,outcome,source,evidence)
  on aegis_observability.journey_events to supabase_auth_admin;
grant usage on sequence aegis_observability.journey_events_id_seq to supabase_auth_admin;
create policy auth_password_journey_read on aegis_observability.journey_events for select to supabase_auth_admin
  using(source='auth_password_verification');
create policy auth_password_journey_insert on aegis_observability.journey_events for insert to supabase_auth_admin
  with check(source='auth_password_verification' and evidence='server' and session_id is null
    and device_ref is null and message_id is null and error_code is null and request_id is null
    and ((stage='auth_password_verified' and outcome='success') or (stage='auth_password_rejected' and outcome='failure')));
create function public.hook_password_verification_audit(event jsonb) returns jsonb
language sql security invoker set search_path='' as $$select aegis_observability.password_verification_attempt(event)$$;
revoke all on function public.hook_password_verification_audit(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.hook_password_verification_audit(jsonb) to supabase_auth_admin;
