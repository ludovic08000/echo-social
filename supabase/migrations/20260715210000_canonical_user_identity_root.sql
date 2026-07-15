begin;

create table if not exists public.user_identity_roots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  primary_device_id text not null,
  identity_pub_b64 text not null check (char_length(identity_pub_b64) between 32 and 4096),
  generation integer not null default 1 check (generation > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_identity_roots enable row level security;
revoke all on public.user_identity_roots from anon;
grant select on public.user_identity_roots to authenticated;

-- Clients read roots for cryptographic verification. Writes only pass through
-- the security-definer RPC below so accidental root replacement is impossible.
drop policy if exists user_identity_roots_select_authenticated
  on public.user_identity_roots;
create policy user_identity_roots_select_authenticated
on public.user_identity_roots
for select
to authenticated
using (true);

create or replace function public.publish_user_identity_root(
  p_primary_device_id text,
  p_identity_pub_b64 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.user_identity_roots%rowtype;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  if p_primary_device_id is null
     or char_length(p_primary_device_id) < 8
     or p_identity_pub_b64 is null
     or char_length(p_identity_pub_b64) < 32 then
    raise exception 'INVALID_IDENTITY_ROOT' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.user_devices ud
    where ud.user_id = v_uid
      and ud.device_id = p_primary_device_id
      and ud.is_primary = true
      and ud.is_active = true
      and ud.approval_status = 'approved'
      and ud.revoked_at is null
  ) then
    raise exception 'PRIMARY_DEVICE_NOT_APPROVED' using errcode = '42501';
  end if;

  select * into v_existing
  from public.user_identity_roots
  where user_id = v_uid
  for update;

  if found then
    if v_existing.identity_pub_b64 <> p_identity_pub_b64 then
      raise exception 'IDENTITY_ROOT_MISMATCH'
        using errcode = '42501',
              detail = 'An explicit identity rotation procedure is required.';
    end if;

    update public.user_identity_roots
    set primary_device_id = p_primary_device_id,
        updated_at = now()
    where user_id = v_uid;

    return jsonb_build_object(
      'ok', true,
      'created', false,
      'generation', v_existing.generation
    );
  end if;

  insert into public.user_identity_roots (
    user_id,
    primary_device_id,
    identity_pub_b64
  ) values (
    v_uid,
    p_primary_device_id,
    p_identity_pub_b64
  );

  return jsonb_build_object('ok', true, 'created', true, 'generation', 1);
end;
$$;

revoke all on function public.publish_user_identity_root(text, text) from public;
grant execute on function public.publish_user_identity_root(text, text) to authenticated;

create or replace function public.get_signed_device_list(
  p_user_id uuid
)
returns table (
  device_id text,
  device_public_key text,
  is_primary boolean,
  primary_device_id text,
  primary_pub_b64 text,
  signature_b64 text,
  signed_at timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with approved_devices as (
    select ud.device_id, ud.device_public_key, ud.is_primary
    from public.user_devices ud
    where ud.user_id = p_user_id
      and ud.is_active = true
      and ud.approval_status = 'approved'
      and ud.revoked_at is null
  ),
  canonical_root as (
    select r.primary_device_id, r.identity_pub_b64
    from public.user_identity_roots r
    where r.user_id = p_user_id
  ),
  valid_signature_rows as (
    select distinct on (uds.device_id)
      uds.device_id,
      uds.primary_device_id,
      uds.primary_pub_b64,
      uds.signature_b64,
      uds.signed_at
    from public.user_device_signatures uds
    join canonical_root root
      on root.primary_device_id = uds.primary_device_id
     and root.identity_pub_b64 = uds.primary_pub_b64
    where uds.user_id = p_user_id
      and uds.revoked_at is null
      and uds.signature_b64 is not null
    order by uds.device_id, uds.signed_at desc
  )
  select
    ad.device_id,
    ad.device_public_key,
    ad.is_primary,
    case when ad.is_primary then null else sig.primary_device_id end,
    root.identity_pub_b64,
    case when ad.is_primary then null else sig.signature_b64 end,
    case when ad.is_primary then null else sig.signed_at end
  from approved_devices ad
  left join canonical_root root on true
  left join valid_signature_rows sig on sig.device_id = ad.device_id
  order by ad.is_primary desc, ad.device_id;
$$;

revoke all on function public.get_signed_device_list(uuid) from public;
grant execute on function public.get_signed_device_list(uuid) to authenticated;

commit;
