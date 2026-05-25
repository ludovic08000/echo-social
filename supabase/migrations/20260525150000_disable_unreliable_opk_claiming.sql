-- Disable unreliable one-time prekey claiming until local OPK backup/restore is guaranteed.
--
-- Rationale:
-- X3DH supports an optional one-time prekey. If the sender uses an OPK, the
-- receiver must still have the matching private OPK locally. Production logs
-- showed server OPKs whose private counterpart was missing on the receiving
-- device. Returning an OPK in that state creates unreadable device copies.
--
-- Stable behavior for now: return no OPK so new sessions use the normal
-- 3-DH X3DH path with IK + EK + SPK only. This is preferable to advertising
-- unusable OPKs.

create or replace function public.claim_device_one_time_prekey(
  p_user_id uuid,
  p_device_id text
)
returns table (
  opk_id integer,
  public_key text
)
language sql
security definer
set search_path = public
as $$
  select null::integer as opk_id, null::text as public_key
  where false;
$$;

grant execute on function public.claim_device_one_time_prekey(uuid, text) to authenticated;

-- Remove stale public OPKs so senders cannot claim key material that no longer
-- has a guaranteed private counterpart in the recipient's local storage.
delete from public.device_one_time_prekeys;
