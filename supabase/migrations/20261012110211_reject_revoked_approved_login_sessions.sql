begin;

-- Une approbation locale ne ressuscite jamais une session révoquée par Auth.
-- On conserve le drapeau de déploiement et on ne touche à aucune clé privée.
create or replace function public.is_current_login_session_approved()
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean := false;
  v_session_id uuid;
begin
  if coalesce(auth.role(), '') = 'service_role' then return true; end if;
  if auth.uid() is null then return false; end if;
  select config.enforcement_enabled into v_enabled
    from public.login_security_config config where config.id = 1;
  if not coalesce(v_enabled, false) then return true; end if;
  v_session_id := public.current_login_security_session_id();
  if v_session_id is null then return false; end if;
  return exists (
    select 1 from public.login_security_sessions security_session
    join auth.sessions auth_session on auth_session.id = security_session.session_id
      and auth_session.user_id = security_session.user_id
    where security_session.user_id = auth.uid()
      and security_session.session_id = v_session_id
      and security_session.status = 'approved'
      and security_session.expires_at > now()
      and (auth_session.not_after is null or auth_session.not_after > now())
  );
end;
$$;
revoke all on function public.is_current_login_session_approved() from public, anon;
grant execute on function public.is_current_login_session_approved() to authenticated, service_role;
commit;
