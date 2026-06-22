-- Pending or rejected devices cannot be active.
-- This blocks legacy client upsert paths from accidentally activating an
-- unapproved device.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_devices_pending_inactive_chk'
  ) then
    alter table public.user_devices
      add constraint user_devices_pending_inactive_chk
      check (approval_status = 'approved' or is_active = false);
  end if;
end $$;
