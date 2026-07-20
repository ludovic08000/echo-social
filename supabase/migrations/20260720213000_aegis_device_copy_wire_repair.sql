-- Aegis device-copy wire repair.
--
-- One immutable predicate now owns the accepted device-copy formats. Old
-- Sesame/X3DH rows are intentionally discarded: the application is not yet in
-- production and must never replay them through the Aegis transaction.

begin;

create or replace function public.is_supported_aegis_device_copy(p_body text)
returns boolean
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select
    p_body like 'aegis1.ratchet.%'
    or p_body like 'aegis1.init.v1.%';
$$;

revoke all on function public.is_supported_aegis_device_copy(text)
from public, anon, authenticated;
grant execute on function public.is_supported_aegis_device_copy(text)
to authenticated;

-- The user explicitly chose a hard cutover with no legacy-message retention.
delete from public.message_device_copies
where not public.is_supported_aegis_device_copy(encrypted_body);

alter table public.message_device_copies
  drop constraint if exists message_device_copies_sesame_lite_wire_check;
alter table public.message_device_copies
  drop constraint if exists message_device_copies_aegis_v1_wire_check;
alter table public.message_device_copies
  add constraint message_device_copies_aegis_v1_wire_check
  check (public.is_supported_aegis_device_copy(encrypted_body));

-- Device-copy writes are server-owned. This removes the original direct-write
-- policy so an old browser build cannot bypass the atomic Aegis RPC.
drop policy if exists "Sender can insert device copies"
on public.message_device_copies;
revoke insert on public.message_device_copies from anon, authenticated;

-- Keep the cutover terminal even if a partially-upgraded database retained an
-- older RPC overload.
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
