begin;

alter table public.identity_rotation_requests
  add column if not exists recovery_blob text,
  add column if not exists recovery_iv text,
  add column if not exists recovery_blob_version integer,
  add column if not exists recovery_attached_at timestamptz,
  add column if not exists recovery_cleared_at timestamptz;

create or replace function public.attach_identity_rotation_recovery_v1(
  p_user_id uuid,
  p_rotation_id uuid,
  p_recovery_blob text,
  p_recovery_iv text,
  p_recovery_blob_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.identity_rotation_requests%rowtype;
begin
  select request.*
    into v_request
    from public.identity_rotation_requests request
   where request.id = p_rotation_id
     and request.user_id = p_user_id
   for update;

  if not found then
    raise exception 'identity_rotation_request_not_found';
  end if;
  if v_request.committed_at is not null then
    raise exception 'identity_rotation_already_committed';
  end if;
  if v_request.cancelled_at is not null then
    raise exception 'identity_rotation_cancelled';
  end if;
  if v_request.expires_at <= clock_timestamp() then
    raise exception 'identity_rotation_expired';
  end if;
  if p_recovery_blob_version <> 1
     or octet_length(coalesce(p_recovery_blob, '')) < 128
     or octet_length(p_recovery_blob) > 131072
     or octet_length(coalesce(p_recovery_iv, '')) < 16
     or octet_length(p_recovery_iv) > 64 then
    raise exception 'identity_rotation_recovery_invalid';
  end if;

  if v_request.recovery_blob is not null then
    if v_request.recovery_blob = p_recovery_blob
       and v_request.recovery_iv = p_recovery_iv
       and v_request.recovery_blob_version = p_recovery_blob_version then
      return jsonb_build_object(
        'ok', true,
        'code', 'IDENTITY_ROTATION_RECOVERY_ALREADY_ATTACHED',
        'rotation_id', v_request.id
      );
    end if;
    raise exception 'identity_rotation_recovery_already_attached';
  end if;

  update public.identity_rotation_requests
     set recovery_blob = p_recovery_blob,
         recovery_iv = p_recovery_iv,
         recovery_blob_version = p_recovery_blob_version,
         recovery_attached_at = clock_timestamp(),
         recovery_cleared_at = null
   where id = v_request.id;

  return jsonb_build_object(
    'ok', true,
    'code', 'IDENTITY_ROTATION_RECOVERY_ATTACHED',
    'rotation_id', v_request.id
  );
end;
$$;

create or replace function public.require_identity_rotation_recovery_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if old.committed_at is null and new.committed_at is not null then
    if new.recovery_blob_version <> 1
       or new.recovery_blob is null
       or new.recovery_iv is null
       or new.recovery_attached_at is null then
      raise exception using
        errcode = '23514',
        message = 'identity_rotation_recovery_required';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.require_identity_rotation_recovery_v1()
  from public, anon, authenticated;

drop trigger if exists require_identity_rotation_recovery_v1
  on public.identity_rotation_requests;
create trigger require_identity_rotation_recovery_v1
before update of committed_at
on public.identity_rotation_requests
for each row
execute function public.require_identity_rotation_recovery_v1();

create or replace function public.finalize_identity_rotation_recovery_v1(
  p_user_id uuid,
  p_rotation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.identity_rotation_requests%rowtype;
begin
  select request.*
    into v_request
    from public.identity_rotation_requests request
   where request.id = p_rotation_id
     and request.user_id = p_user_id
   for update;

  if not found then
    raise exception 'identity_rotation_request_not_found';
  end if;
  if v_request.committed_at is null then
    raise exception 'identity_rotation_not_committed';
  end if;

  update public.identity_rotation_requests
     set recovery_blob = null,
         recovery_iv = null,
         recovery_cleared_at = coalesce(recovery_cleared_at, clock_timestamp())
   where id = v_request.id;

  return jsonb_build_object(
    'ok', true,
    'code', 'IDENTITY_ROTATION_RECOVERY_FINALIZED',
    'rotation_id', v_request.id
  );
end;
$$;

revoke all on function public.attach_identity_rotation_recovery_v1(
  uuid, uuid, text, text, integer
) from public, anon, authenticated;
revoke all on function public.finalize_identity_rotation_recovery_v1(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.attach_identity_rotation_recovery_v1(
  uuid, uuid, text, text, integer
) to service_role;
grant execute on function public.finalize_identity_rotation_recovery_v1(uuid, uuid)
  to service_role;

commit;
