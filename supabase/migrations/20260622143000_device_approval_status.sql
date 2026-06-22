-- E2EE device approval status.
--
-- First deployment step only: add approval states to user_devices.
-- The app treats only approval_status = 'approved' and is_active = true as
-- eligible for fanout / signed device list publication.

alter table public.user_devices
  add column if not exists approval_status text not null default 'approved',
  add column if not exists approval_requested_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid,
  add column if not exists approval_email_sent_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_devices_approval_status_chk'
  ) then
    alter table public.user_devices
      add constraint user_devices_approval_status_chk
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

update public.user_devices
set
  approval_status = 'approved',
  approved_at = coalesce(approved_at, last_seen_at, created_at, now()),
  approved_by = coalesce(approved_by, user_id)
where approval_status = 'approved';

create index if not exists idx_user_devices_approval_status
  on public.user_devices(user_id, approval_status, is_active);
