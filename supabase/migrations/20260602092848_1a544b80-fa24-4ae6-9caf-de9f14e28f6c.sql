
DROP FUNCTION IF EXISTS public.request_device_copy_retry(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.mark_device_copy_retry_request(uuid, text, text);
DROP FUNCTION IF EXISTS public.upsert_signed_device_list(text[], text, text);
DROP FUNCTION IF EXISTS public.quarantine_own_invalid_device(text, text);
DROP FUNCTION IF EXISTS public.quarantine_own_invalid_device_spk(text, integer, text);
DROP FUNCTION IF EXISTS public.cleanup_current_user_stale_devices(text, interval);
DROP FUNCTION IF EXISTS public.is_user_device_revoked(uuid, text);
DROP FUNCTION IF EXISTS public.register_user_device_safe(uuid, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.resolve_device_id_by_fingerprints(text[], text);
DROP FUNCTION IF EXISTS public.request_device_prekey_repair(uuid, text, text);
DROP FUNCTION IF EXISTS public.consume_device_prekey_repair_requests(integer);
