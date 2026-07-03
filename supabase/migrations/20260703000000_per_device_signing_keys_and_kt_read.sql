-- =====================================================================
-- Per-device identity signing keys + Key Transparency read path
-- =====================================================================
--
-- ⚠️  REVIEW BEFORE APPLYING. This migration was authored offline and has
--     NOT been run against a live database. Verify column/RPC names against
--     the current schema, run in a staging project first, and confirm RLS.
--
-- Purpose
-- -------
-- 1. Multi-device signature verification: each installation generates its own
--    identity key pair, so pairwise Double-Ratchet messages are signed with the
--    SENDING device's Ed25519 key. Receivers must be able to fetch that key by
--    the device's identity fingerprint (== ratchet envelope `fp`) instead of
--    verifying every message against a single account-level key.
--
-- 2. Key Transparency read path: expose signed Merkle tree heads + inclusion
--    proofs so clients can (in a later change) verify that the key served for a
--    peer is the one committed to the append-only log.
--
-- Client side that consumes this:
--   - src/lib/crypto/peerDeviceSigningKeys.ts  -> list_device_identity_keys_for_user
--   - (future) KT verifier                     -> kt_get_inclusion_proof / kt_latest_head
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Per-device identity signing key columns
-- ---------------------------------------------------------------------
ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS identity_signing_key text,
  ADD COLUMN IF NOT EXISTS identity_fingerprint text;

COMMENT ON COLUMN public.user_devices.identity_signing_key IS
  'Base64 Ed25519 public signing key of this device''s identity key pair. Used to verify pairwise Double-Ratchet message signatures from this device.';
COMMENT ON COLUMN public.user_devices.identity_fingerprint IS
  'Fingerprint of this device''s X25519 identity public key; equals the ratchet envelope `fp`. Used to resolve identity_signing_key at decrypt time.';

CREATE INDEX IF NOT EXISTS idx_user_devices_identity_fp
  ON public.user_devices(user_id, identity_fingerprint)
  WHERE identity_fingerprint IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Read RPC: per-device identity signing keys for a user
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_device_identity_keys_for_user(uuid);

CREATE FUNCTION public.list_device_identity_keys_for_user(p_user_id uuid)
RETURNS TABLE (
  device_id text,
  identity_fingerprint text,
  identity_signing_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT d.device_id, d.identity_fingerprint, d.identity_signing_key
  FROM public.user_devices d
  WHERE d.user_id = p_user_id
    AND d.is_active = true
    AND d.revoked_at IS NULL
    AND d.identity_fingerprint IS NOT NULL
    AND length(trim(d.identity_fingerprint)) > 0
    AND d.identity_signing_key IS NOT NULL
    AND length(trim(d.identity_signing_key)) > 0
    AND d.last_seen_at > now() - interval '45 days';
$function$;

GRANT EXECUTE ON FUNCTION public.list_device_identity_keys_for_user(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. Publish path: extend register_user_device_safe to also store the
--    identity signing key + fingerprint.
--
--    NOTE: register_user_device_safe already exists with a fixed signature.
--    Rather than redefine it blindly here (its body varies across migrations),
--    prefer adding two OPTIONAL parameters with defaults so existing callers
--    keep working. The block below is a TEMPLATE — reconcile it with the
--    current function body before applying.
-- ---------------------------------------------------------------------
-- Example shape (adapt to the live definition):
--
-- CREATE OR REPLACE FUNCTION public.register_user_device_safe(
--   p_user_id uuid,
--   p_device_id text,
--   p_device_name text,
--   p_device_public_key text,
--   p_device_fingerprint text,
--   p_platform text,
--   p_user_agent text,
--   p_identity_signing_key text DEFAULT NULL,
--   p_identity_fingerprint text DEFAULT NULL
-- ) RETURNS jsonb
-- LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
-- AS $$
-- BEGIN
--   -- ... existing revoked/approval checks ...
--   INSERT INTO public.user_devices AS d (
--     user_id, device_id, device_name, device_public_key, fingerprint,
--     platform, user_agent, is_active, last_seen_at,
--     identity_signing_key, identity_fingerprint
--   ) VALUES (
--     p_user_id, p_device_id, p_device_name, p_device_public_key, p_device_fingerprint,
--     p_platform, p_user_agent, true, now(),
--     p_identity_signing_key, p_identity_fingerprint
--   )
--   ON CONFLICT (user_id, device_id) DO UPDATE SET
--     device_public_key   = EXCLUDED.device_public_key,
--     last_seen_at        = now(),
--     identity_signing_key = COALESCE(EXCLUDED.identity_signing_key, d.identity_signing_key),
--     identity_fingerprint = COALESCE(EXCLUDED.identity_fingerprint, d.identity_fingerprint);
--   RETURN jsonb_build_object('ok', true);
-- END;
-- $$;

-- ---------------------------------------------------------------------
-- 4. Key Transparency read RPCs (for the future client-side verifier)
--    Assumes tables e2ee_kt_tree_heads(epoch, root, leaf_count, prev_epoch,
--    signature, created_at) and e2ee_kt_leaves(epoch, leaf_index, leaf_hash,
--    user_id, ...) from the kt-publish-epoch edge function.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.kt_latest_head();

CREATE FUNCTION public.kt_latest_head()
RETURNS TABLE (
  epoch bigint,
  root text,
  leaf_count bigint,
  prev_epoch bigint,
  signature text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT h.epoch, h.root, h.leaf_count, h.prev_epoch, h.signature, h.created_at
  FROM public.e2ee_kt_tree_heads h
  ORDER BY h.epoch DESC
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.kt_latest_head() TO authenticated;

-- Returns the leaves needed to recompute an inclusion proof for a user's most
-- recent transparency entries. The client recomputes the Merkle path locally
-- (ktMerkle.buildInclusionProof / verifyInclusionProof) and checks it against
-- the signed head root — so the server cannot forge inclusion.
DROP FUNCTION IF EXISTS public.kt_get_epoch_leaves(bigint);

CREATE FUNCTION public.kt_get_epoch_leaves(p_epoch bigint)
RETURNS TABLE (
  leaf_index bigint,
  leaf_hash text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT l.leaf_index, l.leaf_hash
  FROM public.e2ee_kt_leaves l
  WHERE l.epoch = p_epoch
  ORDER BY l.leaf_index ASC;
$function$;

GRANT EXECUTE ON FUNCTION public.kt_get_epoch_leaves(bigint) TO authenticated;
