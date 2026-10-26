begin;

-- The gateway verifies the JWT signature. This RPC additionally verifies its
-- live Auth session: an otherwise unexpired JWT must not outlive a sign-out.
-- No session/user argument is accepted and no Auth row is returned to callers.
create or replace function public.feed_api_session_active()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id text := auth.jwt() ->> 'session_id';
begin
  if coalesce(auth.role(), '') <> 'authenticated' or v_user_id is null then
    return false;
  end if;
  if v_session_id is null or v_session_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1 from auth.sessions as session
    where session.id = v_session_id::uuid
      and session.user_id = v_user_id
      and (session.not_after is null or session.not_after > now())
  );
end;
$$;

revoke all on function public.feed_api_session_active() from public, anon, service_role;
grant execute on function public.feed_api_session_active() to authenticated;
comment on function public.feed_api_session_active() is
  'Caller-bound live Auth session check for feed-api. Does not approve login/device, expose Auth rows, or alter existing RLS.';

commit;
