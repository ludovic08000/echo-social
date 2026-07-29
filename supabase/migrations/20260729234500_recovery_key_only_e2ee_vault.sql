begin;

create or replace function public.reject_weak_e2ee_backup()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.backup_type <> 'recovery' then
    raise exception using
      errcode = '22023',
      message = 'E2EE_RECOVERY_KEY_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists user_backups_recovery_key_only on public.user_backups;
create trigger user_backups_recovery_key_only
before insert or update of backup_type on public.user_backups
for each row execute function public.reject_weak_e2ee_backup();

create or replace function public.reject_server_pin_backup()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = '22023',
    message = 'SERVER_PIN_BACKUP_DISABLED';
end;
$$;

drop trigger if exists backup_pin_state_local_only on public.backup_pin_state;
create trigger backup_pin_state_local_only
before insert or update on public.backup_pin_state
for each row execute function public.reject_server_pin_backup();

-- These rows are offline-verifiable with a human secret. Strict recovery mode
-- deliberately removes them; recovery-key rows remain untouched.
delete from public.backup_pin_state;
delete from public.user_backups where backup_type = 'account';

comment on function public.reject_weak_e2ee_backup() is
  'Forbids password-wrapped E2EE backups; only 256-bit recovery-key envelopes are accepted.';
comment on function public.reject_server_pin_backup() is
  'Forbids server-side six-digit PIN wrappers; chat PIN is a local application lock only.';

commit;
