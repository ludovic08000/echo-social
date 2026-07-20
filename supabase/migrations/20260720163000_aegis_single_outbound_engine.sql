-- Final Aegis-only cutover.
--
-- 1. Remove the parallel message-edit device-copy protocol. Editing is disabled
--    until it can be represented by the same immutable Aegis transaction.
-- 2. Make device lifecycle writes server-authoritative. Authenticated clients
--    may read their devices but can mutate them only through audited RPCs.

begin;

drop function if exists public.send_message_edit_with_device_copies(
  uuid, uuid, text, text, jsonb
);

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_edit_device_copies'
  ) then
    alter publication supabase_realtime drop table public.message_edit_device_copies;
  end if;
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_edits'
  ) then
    alter publication supabase_realtime drop table public.message_edits;
  end if;
end;
$$;

drop table if exists public.message_edit_device_copies cascade;
drop table if exists public.message_edits cascade;

drop policy if exists "devices owner manage" on public.user_devices;
drop policy if exists "Users can register their own devices" on public.user_devices;
drop policy if exists "Users can update their own devices" on public.user_devices;
drop policy if exists "Users can delete their own devices" on public.user_devices;

revoke insert, update, delete on table public.user_devices from anon, authenticated;
grant select on table public.user_devices to authenticated;

create or replace function public.revoke_user_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if length(v_device_id) < 8 then
    raise exception 'INVALID_DEVICE_ID' using errcode = '22023';
  end if;

  update public.user_devices
  set is_active = false,
      revoked_at = coalesce(revoked_at, now()),
      revoke_reason = coalesce(revoke_reason, 'manual'),
      stale_at = coalesce(stale_at, now()),
      updated_at = now()
  where user_id = v_uid
    and device_id = v_device_id
    and revoked_at is null;

  if not found then
    raise exception 'DEVICE_NOT_FOUND_OR_ALREADY_REVOKED' using errcode = 'P0002';
  end if;

  delete from public.user_device_signatures
  where user_id = v_uid
    and (device_id = v_device_id or primary_device_id = v_device_id);

  perform public.ensure_primary_device_exists(v_uid);

  return jsonb_build_object(
    'ok', true,
    'device_id', v_device_id,
    'status', 'revoked'
  );
end;
$$;

revoke all on function public.revoke_user_device(text) from public;
grant execute on function public.revoke_user_device(text) to authenticated;

comment on function public.revoke_user_device(text) is
  'Server-authoritative revocation for one device owned by auth.uid().';

commit;
