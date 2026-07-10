-- ============================================================================
-- Harden E2EE storage RLS and device revocation invariants
-- ============================================================================
--
-- Security goals:
--   1. Historical ratchet archives are never retained off-device.
--   2. Session escrow remains opt-in client-side and may only be accessed by the
--      authenticated owner from an active, non-revoked device.
--   3. A revoked device cannot reactivate itself by updating revoked_at to NULL.
--   4. The immutable (user_id, device_id) identity of a device row cannot be
--      rewritten by an authenticated client.
--
-- Apply in staging first and verify the user_devices/e2ee_session_sync tables
-- exist from their earlier migrations.
-- ============================================================================

BEGIN;

-- Forward-secrecy cleanup: the hardened client never uploads previous ratchet
-- states. Remove any legacy archive rows before narrowing the constraint.
DELETE FROM public.e2ee_session_sync
WHERE kind = 'archive';

ALTER TABLE public.e2ee_session_sync
  DROP CONSTRAINT IF EXISTS e2ee_session_sync_kind_chk;

ALTER TABLE public.e2ee_session_sync
  ADD CONSTRAINT e2ee_session_sync_kind_chk
  CHECK (kind = 'session');

ALTER TABLE public.e2ee_session_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.e2ee_session_sync FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.e2ee_session_sync FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.e2ee_session_sync TO authenticated;

-- Replace the original owner-only policies with owner + active-device policies.
DROP POLICY IF EXISTS "session_sync owner select" ON public.e2ee_session_sync;
DROP POLICY IF EXISTS "session_sync owner insert" ON public.e2ee_session_sync;
DROP POLICY IF EXISTS "session_sync owner update" ON public.e2ee_session_sync;
DROP POLICY IF EXISTS "session_sync owner delete" ON public.e2ee_session_sync;

CREATE POLICY "session_sync active device select"
ON public.e2ee_session_sync
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  AND kind = 'session'
  AND EXISTS (
    SELECT 1
    FROM public.user_devices AS device
    WHERE device.user_id = auth.uid()
      AND device.device_id = e2ee_session_sync.device_id
      AND device.revoked_at IS NULL
  )
);

CREATE POLICY "session_sync active device insert"
ON public.e2ee_session_sync
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND kind = 'session'
  AND EXISTS (
    SELECT 1
    FROM public.user_devices AS device
    WHERE device.user_id = auth.uid()
      AND device.device_id = e2ee_session_sync.device_id
      AND device.revoked_at IS NULL
  )
);

CREATE POLICY "session_sync active device update"
ON public.e2ee_session_sync
FOR UPDATE
TO authenticated
USING (
  auth.uid() = user_id
  AND kind = 'session'
  AND EXISTS (
    SELECT 1
    FROM public.user_devices AS device
    WHERE device.user_id = auth.uid()
      AND device.device_id = e2ee_session_sync.device_id
      AND device.revoked_at IS NULL
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND kind = 'session'
  AND EXISTS (
    SELECT 1
    FROM public.user_devices AS device
    WHERE device.user_id = auth.uid()
      AND device.device_id = e2ee_session_sync.device_id
      AND device.revoked_at IS NULL
  )
);

-- Owners may delete stale rows for cleanup even after the source device has
-- been revoked, but they cannot read or update those rows.
CREATE POLICY "session_sync owner delete"
ON public.e2ee_session_sync
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.enforce_user_device_revocation_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Administrative service-role maintenance may deliberately repair a row.
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.device_id IS DISTINCT FROM NEW.device_id THEN
    RAISE EXCEPTION 'DEVICE_IDENTITY_IMMUTABLE'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'DEVICE_REVOKED_CANNOT_REACTIVATE'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_user_device_revocation_invariants() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_enforce_user_device_revocation_invariants
ON public.user_devices;

CREATE TRIGGER trg_enforce_user_device_revocation_invariants
BEFORE UPDATE OF user_id, device_id, revoked_at
ON public.user_devices
FOR EACH ROW
EXECUTE FUNCTION public.enforce_user_device_revocation_invariants();

COMMIT;
