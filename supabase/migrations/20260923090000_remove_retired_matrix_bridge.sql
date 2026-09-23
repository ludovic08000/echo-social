-- Matrix delivery was retired in favor of the single Aegis/Libsignal path.
-- The two bridge tables are empty in production; remove the remaining schema
-- entry points so no caller can accidentally revive a parallel transport.

begin;

drop function if exists public.claim_matrix_conversation_room(uuid, text);
drop function if exists public.get_matrix_conversation_route(uuid);

drop table if exists public.matrix_room_mappings;
drop table if exists public.matrix_user_mappings;

commit;
