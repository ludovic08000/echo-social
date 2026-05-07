-- ============================================================
-- L4 — Multi-device signed device list (WhatsApp Whitepaper v9)
-- ============================================================

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- One primary device per user (enforced via partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS user_devices_one_primary_per_user
  ON public.user_devices (user_id)
  WHERE is_primary = true AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.user_device_signatures (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  primary_device_id TEXT NOT NULL,
  -- Ed25519 raw public of the primary device that produced the signature
  primary_pub_b64 TEXT NOT NULL,
  -- Ed25519 signature over canonical JSON {u, d, dp, ts}
  signature_b64 TEXT NOT NULL,
  signed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  revoked_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT user_device_signatures_uniq UNIQUE (user_id, device_id, primary_device_id)
);

CREATE INDEX IF NOT EXISTS idx_uds_user_active
  ON public.user_device_signatures (user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.user_device_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uds_owner_insert" ON public.user_device_signatures;
CREATE POLICY "uds_owner_insert"
  ON public.user_device_signatures
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "uds_owner_update" ON public.user_device_signatures;
CREATE POLICY "uds_owner_update"
  ON public.user_device_signatures
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "uds_owner_delete" ON public.user_device_signatures;
CREATE POLICY "uds_owner_delete"
  ON public.user_device_signatures
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Public-read via SECURITY DEFINER RPC (no direct SELECT — narrows surface)
DROP POLICY IF EXISTS "uds_no_direct_select" ON public.user_device_signatures;
CREATE POLICY "uds_no_direct_select"
  ON public.user_device_signatures
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.get_signed_device_list(p_user_id UUID)
RETURNS TABLE (
  device_id TEXT,
  device_public_key TEXT,
  is_primary BOOLEAN,
  primary_device_id TEXT,
  primary_pub_b64 TEXT,
  signature_b64 TEXT,
  signed_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    d.device_id,
    d.device_public_key,
    d.is_primary,
    s.primary_device_id,
    s.primary_pub_b64,
    s.signature_b64,
    s.signed_at
  FROM public.user_devices d
  LEFT JOIN public.user_device_signatures s
    ON s.user_id = d.user_id
   AND s.device_id = d.device_id
   AND s.revoked_at IS NULL
  WHERE d.user_id = p_user_id
    AND d.is_active = true
    AND d.revoked_at IS NULL
  ORDER BY d.is_primary DESC, d.created_at ASC;
$$;

REVOKE ALL ON FUNCTION public.get_signed_device_list(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_signed_device_list(UUID) TO authenticated;