-- Aegis core finalization.
--
-- The server owns device-root transitions and accepts one immutable outbound
-- protocol only. Historical migrations remain as an append-only ledger, but
-- their runtime functions/triggers are removed here.

begin;

drop trigger if exists trg_handle_primary_device_loss on public.user_devices;
drop trigger if exists ensure_primary_after_device_change on public.user_devices;
drop function if exists public.handle_primary_device_loss();
drop function if exists public.trg_ensure_primary_after_change();

create or replace function public.ensure_primary_device_exists(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_primary public.user_devices%rowtype;
  v_candidate public.user_devices%rowtype;
  v_root_device_id text;
  v_candidate_ids text[] := array[]::text[];
begin
  if p_user_id is null then
    return;
  end if;

  -- Serialize every root decision for this account.
  perform 1
  from public.user_devices
  where user_id = p_user_id
  order by id
  for update;

  select * into v_primary
  from public.user_devices
  where user_id = p_user_id
    and is_primary = true
    and is_active = true
    and coalesce(approval_status, 'approved') = 'approved'
    and revoked_at is null
    and stale_at is null
    and nullif(trim(coalesce(device_public_key, '')), '') is not null
  order by last_seen_at desc nulls last, created_at desc
  limit 1;

  if found then
    select primary_device_id into v_root_device_id
    from public.user_identity_roots
    where user_id = p_user_id
    for update;

    if v_root_device_id is distinct from v_primary.device_id then
      update public.user_identity_roots
      set primary_device_id = v_primary.device_id,
          updated_at = now()
      where user_id = p_user_id;

      delete from public.user_device_signatures
      where user_id = p_user_id
        and primary_device_id <> v_primary.device_id;
    end if;
    return;
  end if;

  select * into v_candidate
  from public.user_devices
  where user_id = p_user_id
    and is_active = true
    and coalesce(approval_status, 'approved') = 'approved'
    and revoked_at is null
    and stale_at is null
    and nullif(trim(coalesce(device_public_key, '')), '') is not null
  order by last_seen_at desc nulls last, created_at desc
  limit 1;

  if not found then
    return;
  end if;

  update public.user_devices
  set is_primary = false,
      updated_at = now()
  where user_id = p_user_id
    and is_primary = true;

  update public.user_devices
  set is_primary = true,
      updated_at = now()
  where id = v_candidate.id;

  -- The account signing identity is immutable. Only its currently authorized
  -- device anchor moves; no secret or identity key is generated server-side.
  update public.user_identity_roots
  set primary_device_id = v_candidate.device_id,
      updated_at = now()
  where user_id = p_user_id;

  delete from public.user_device_signatures
  where user_id = p_user_id;

  update public.device_signed_prekeys
  set keys_epoch = greatest(keys_epoch + 1, spk_id + 1)
  where user_id = p_user_id
    and device_id = v_candidate.device_id
    and is_active = true;

  select coalesce(array_agg(device_id order by last_seen_at desc nulls last), array[]::text[])
    into v_candidate_ids
  from public.user_devices
  where user_id = p_user_id
    and is_active = true
    and coalesce(approval_status, 'approved') = 'approved'
    and revoked_at is null
    and stale_at is null;

  update public.device_primary_repair_requests
  set resolved_at = now()
  where user_id = p_user_id
    and resolved_at is null;

  insert into public.device_primary_repair_requests(
    user_id, reason, candidate_device_ids
  ) values (
    p_user_id, 'aegis_primary_rotated', v_candidate_ids
  );
end;
$$;

revoke all on function public.ensure_primary_device_exists(uuid)
from public, anon, authenticated;

-- Every server-owned lifecycle RPC converges through the same root repair,
-- including older cleanup/quarantine functions that only toggle is_active.
-- is_primary is deliberately absent from the trigger columns so the two-step
-- explicit replacement transaction cannot race an intermediate promotion.
create or replace function public.trg_aegis_reconcile_device_root()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ensure_primary_device_exists(new.user_id);
  return new;
end;
$$;

drop trigger if exists aegis_reconcile_device_root on public.user_devices;
create trigger aegis_reconcile_device_root
after insert or update of
  is_active, revoked_at, stale_at, approval_status, device_public_key, last_seen_at
on public.user_devices
for each row
execute function public.trg_aegis_reconcile_device_root();

revoke all on function public.trg_aegis_reconcile_device_root()
from public, anon, authenticated;

-- Approval is an authenticated account action. Cryptographic publication is
-- still performed by the client only after its private keys have loaded.
create or replace function public.approve_user_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_row public.user_devices%rowtype;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if length(v_device_id) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
  end if;

  select * into v_row
  from public.user_devices
  where user_id = v_user
    and device_id = v_device_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;
  if v_row.revoked_at is not null or v_row.approval_status = 'rejected' then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  end if;
  if nullif(trim(coalesce(v_row.device_public_key, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_PUBLIC_KEY_MISSING');
  end if;

  update public.user_devices
  set approval_status = 'approved',
      is_active = true,
      approved_at = coalesce(approved_at, now()),
      approved_by = coalesce(approved_by, v_user),
      rejected_at = null,
      rejected_by = null,
      stale_at = null,
      last_seen_at = now(),
      updated_at = now()
  where user_id = v_user
    and device_id = v_device_id;

  perform public.ensure_primary_device_exists(v_user);

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_APPROVED',
    'status', 'approved',
    'device_id', v_device_id
  );
end;
$$;

revoke all on function public.approve_user_device(text) from public;
grant execute on function public.approve_user_device(text) to authenticated;

drop function if exists public.revoke_user_device(text);

create function public.revoke_user_device(
  p_device_id text,
  p_replacement_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_replacement_id text := trim(coalesce(p_replacement_device_id, ''));
  v_target public.user_devices%rowtype;
  v_primary_changed boolean := false;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if length(v_device_id) < 8 then
    raise exception 'INVALID_DEVICE_ID' using errcode = '22023';
  end if;

  select * into v_target
  from public.user_devices
  where user_id = v_uid
    and device_id = v_device_id
    and revoked_at is null
  for update;

  if not found then
    raise exception 'DEVICE_NOT_FOUND_OR_ALREADY_REVOKED' using errcode = 'P0002';
  end if;

  v_primary_changed := v_target.is_primary or exists (
    select 1 from public.user_identity_roots
    where user_id = v_uid
      and primary_device_id = v_device_id
  );

  if v_primary_changed then
    if length(v_replacement_id) < 8 or v_replacement_id = v_device_id then
      raise exception 'ACTIVE_REPLACEMENT_DEVICE_REQUIRED' using errcode = '22023';
    end if;
    perform 1
    from public.user_devices
    where user_id = v_uid
      and device_id = v_replacement_id
      and is_active = true
      and coalesce(approval_status, 'approved') = 'approved'
      and revoked_at is null
      and stale_at is null
      and nullif(trim(coalesce(device_public_key, '')), '') is not null
    for update;
    if not found then
      raise exception 'REPLACEMENT_DEVICE_NOT_ELIGIBLE' using errcode = '42501';
    end if;

    update public.user_devices
    set is_primary = false,
        updated_at = now()
    where user_id = v_uid
      and is_primary = true;

    update public.user_devices
    set is_primary = true,
        updated_at = now()
    where user_id = v_uid
      and device_id = v_replacement_id;

    update public.user_identity_roots
    set primary_device_id = v_replacement_id,
        updated_at = now()
    where user_id = v_uid;

    delete from public.user_device_signatures
    where user_id = v_uid;

    update public.device_signed_prekeys
    set keys_epoch = greatest(keys_epoch + 1, spk_id + 1)
    where user_id = v_uid
      and device_id = v_replacement_id
      and is_active = true;

    update public.device_primary_repair_requests
    set resolved_at = now()
    where user_id = v_uid
      and resolved_at is null;

    insert into public.device_primary_repair_requests(
      user_id, reason, candidate_device_ids
    ) values (
      v_uid, 'aegis_primary_rotated', array[v_replacement_id]
    );
  else
    delete from public.user_device_signatures
    where user_id = v_uid
      and device_id = v_device_id;
  end if;

  update public.user_devices
  set is_active = false,
      is_primary = false,
      revoked_at = now(),
      revoke_reason = coalesce(revoke_reason, 'manual'),
      stale_at = coalesce(stale_at, now()),
      updated_at = now()
  where id = v_target.id;

  return jsonb_build_object(
    'ok', true,
    'device_id', v_device_id,
    'status', 'revoked',
    'primary_changed', v_primary_changed,
    'new_primary_device_id', case when v_primary_changed then v_replacement_id else null end
  );
end;
$$;

revoke all on function public.revoke_user_device(text, text) from public;
grant execute on function public.revoke_user_device(text, text) to authenticated;

-- Document name, MIME and byte size live inside the encrypted Aegis payload.
-- They must never be duplicated as clear database metadata for peer messages.
create or replace function public.enforce_aegis_metadata_minimization()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.body_kind = 'multi_device' then
    new.document_name := null;
    new.document_mime := null;
    new.document_size_bytes := null;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_aegis_metadata_minimization on public.messages;
create trigger enforce_aegis_metadata_minimization
before insert or update of body_kind, document_name, document_mime, document_size_bytes
on public.messages
for each row
execute function public.enforce_aegis_metadata_minimization();

revoke all on function public.enforce_aegis_metadata_minimization()
from public, anon, authenticated;

-- Remove every obsolete send/edit entry point. The only peer-message write
-- authority left is public.aegis_send_message(...).
drop function if exists public.send_message_with_device_copies(
  uuid, text, text, jsonb, jsonb
);
drop function if exists public.send_message_with_device_copies(
  uuid, uuid, text, text, jsonb, jsonb
);
drop function if exists public.send_message_with_device_copies(
  uuid, uuid, text, text, jsonb, jsonb, text
);
drop function if exists public.send_message_edit_with_device_copies(
  uuid, uuid, text, text, jsonb
);

commit;
