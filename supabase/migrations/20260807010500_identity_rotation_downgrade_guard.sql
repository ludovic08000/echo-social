begin;

-- Authenticated clients may republish metadata for the same account identity,
-- but changing the account root is reserved for the verified rotation RPC.
-- SECURITY INVOKER is essential here: direct PostgREST writes must observe the
-- caller role, while commit_identity_rotation_v1 runs as its function owner.
create or replace function public.guard_account_identity_rotation_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and exists (
      select 1
        from public.user_public_keys existing
       where existing.user_id = new.user_id
         and existing.is_active = true
    ) then
      raise exception using
        errcode = '42501',
        message = 'identity_rotation_verified_flow_required';
    end if;

    if tg_op = 'UPDATE' and (
      new.identity_key is distinct from old.identity_key
      or new.signing_key is distinct from old.signing_key
      or new.fingerprint is distinct from old.fingerprint
      or new.identity_binding_signature is distinct from old.identity_binding_signature
      or new.identity_binding_version is distinct from old.identity_binding_version
      or new.identity_epoch is distinct from old.identity_epoch
    ) then
      raise exception using
        errcode = '42501',
        message = 'identity_rotation_verified_flow_required';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_account_identity_rotation_v1()
  from public, anon, authenticated;

drop trigger if exists guard_account_identity_rotation_v1
  on public.user_public_keys;
create trigger guard_account_identity_rotation_v1
before insert or update of
  identity_key,
  signing_key,
  fingerprint,
  identity_binding_signature,
  identity_binding_version,
  identity_epoch
on public.user_public_keys
for each row
execute function public.guard_account_identity_rotation_v1();

-- Preserve authenticated access to the user's own public epoch history while
-- keeping RLS authoritative. The rotation request table itself remains private.
do $$
begin
  create policy "identity epochs own read v1"
    on public.user_identity_epochs
    for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end
$$;

grant select on table public.user_identity_epochs to authenticated;

commit;
