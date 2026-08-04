begin;

create or replace function public.bump_aegis_user_route_version(
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    return;
  end if;

  -- Account deletion can remove auth.users before domain tables are cleaned.
  -- Route invalidation must never recreate a row for a deleted account or
  -- prevent device/key cleanup through its foreign-key constraint.
  if not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = p_user_id
  ) then
    delete from public.aegis_user_route_versions route
    where route.user_id = p_user_id;
    return;
  end if;

  insert into public.aegis_user_route_versions (
    user_id,
    route_version,
    updated_at
  ) values (
    p_user_id,
    1,
    now()
  )
  on conflict (user_id) do update
  set route_version = public.aegis_user_route_versions.route_version + 1,
      updated_at = now();
end;
$$;

revoke all on function public.bump_aegis_user_route_version(uuid)
from public, anon, authenticated;

commit;
