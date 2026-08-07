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
declare
  v_active public.user_public_keys%rowtype;
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      select existing.*
        into v_active
        from public.user_public_keys existing
       where existing.user_id = new.user_id
         and existing.is_active = true
       order by existing.created_at desc
       limit 1;

      if found then
        if new.identity_key is distinct from v_active.identity_key
           or new.signing_key is distinct from v_active.signing_key
           or new.fingerprint is distinct from v_active.fingerprint
           or new.identity_binding_signature is distinct from v_active.identity_binding_signature
           or new.identity_binding_version is distinct from v_active.identity_binding_version then
          raise exception using
            errcode = '42501',
            message = 'identity_rotation_verified_flow_required';
        end if;

        -- Old clients do not know the identity_epoch column. A same-root upsert
        -- inherits the authoritative server epoch instead of defaulting to 1.
        new.identity_epoch := v_active.identity_epoch;
      end if;
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
