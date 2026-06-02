
DROP FUNCTION IF EXISTS public.list_active_devices_for_user(uuid);
DROP FUNCTION IF EXISTS public.get_device_prekey_bundle(uuid, text);
DROP FUNCTION IF EXISTS public.get_active_device_public_key(uuid, text);
DROP FUNCTION IF EXISTS public.get_pending_device_copy_retry_requests(integer);
DROP FUNCTION IF EXISTS public.claim_device_one_time_prekey(uuid, text);
