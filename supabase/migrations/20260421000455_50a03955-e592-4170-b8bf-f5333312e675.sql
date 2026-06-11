-- Multi-device E2EE foundation: per-device signed prekeys
-- Strategy: shared identity key per user (legacy compatible), but each device has its own SPK + ratchets.
-- 100% additive: legacy `user_signed_prekeys` (per-user) keeps working unchanged.

CREATE TABLE IF NOT EXISTS public.device_signed_prekeys (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  spk_id integer NOT NULL,
  public_key text NOT NULL,
  signature text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + interval '30 days'),
  UNIQUE (user_id, device_id, spk_id)
);

CREATE INDEX IF NOT EXISTS idx_device_spk_active
  ON public.device_signed_prekeys (user_id, device_id, is_active, created_at DESC);

ALTER TABLE public.device_signed_prekeys ENABLE ROW LEVEL SECURITY;

-- Owner can manage their own device prekeys
CREATE POLICY "Owner manages own device SPK"
  ON public.device_signed_prekeys
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Anyone authenticated can READ public bundles (needed for X3DH initiator)
CREATE POLICY "Authenticated can read active device SPK"
  ON public.device_signed_prekeys
  FOR SELECT
  TO authenticated
  USING (is_active = true AND expires_at > now());

-- Get the active prekey bundle for a specific (user, device) pair.
-- SECURITY DEFINER so callers can fetch peer bundles without needing
-- direct read on the table from arbitrary policies.
CREATE OR REPLACE FUNCTION public.get_device_prekey_bundle(
  p_user_id uuid,
  p_device_id text
)
RETURNS TABLE (
  spk_id integer,
  public_key text,
  signature text,
  device_public_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sp.spk_id,
    sp.public_key,
    sp.signature,
    d.device_public_key
  FROM public.device_signed_prekeys sp
  JOIN public.user_devices d
    ON d.user_id = sp.user_id
   AND d.device_id = sp.device_id
  WHERE sp.user_id = p_user_id
    AND sp.device_id = p_device_id
    AND sp.is_active = true
    AND sp.expires_at > now()
    AND d.is_active = true
  ORDER BY sp.created_at DESC
  LIMIT 1;
$$;

-- Cleanup helper for expired/inactive prekeys (cron-friendly)
CREATE OR REPLACE FUNCTION public.cleanup_expired_device_prekeys()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.device_signed_prekeys
  WHERE expires_at < now() - interval '7 days';
END;
$$;