ALTER TABLE public.user_signed_prekeys
  ADD COLUMN IF NOT EXISTS signature_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE public.device_signed_prekeys
  ADD COLUMN IF NOT EXISTS signature_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE public.device_one_time_prekeys
  ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE public.device_one_time_prekeys
  ADD COLUMN IF NOT EXISTS signature_version SMALLINT NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS public.claim_device_one_time_prekey(uuid, text);

CREATE FUNCTION public.claim_device_one_time_prekey(
  p_user_id uuid,
  p_device_id text
)
RETURNS TABLE(opk_id integer, public_key text, signature text, signature_version smallint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH claimed AS (
    DELETE FROM public.device_one_time_prekeys
    WHERE id = (
      SELECT id FROM public.device_one_time_prekeys
      WHERE user_id = p_user_id AND device_id = p_device_id
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING opk_id, public_key, signature, signature_version
  )
  SELECT opk_id, public_key, signature, signature_version FROM claimed;
$$;
