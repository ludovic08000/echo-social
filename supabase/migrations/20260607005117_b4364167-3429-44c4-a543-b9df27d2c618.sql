
-- ============================================================
-- Primary-device auto-promotion + relink request infrastructure
-- ============================================================

-- Audit / signal table consumed by the front when a manual repair is needed
CREATE TABLE IF NOT EXISTS public.device_primary_repair_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  reason text NOT NULL,
  candidate_device_ids text[] NOT NULL DEFAULT '{}',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.device_primary_repair_requests TO authenticated;
GRANT ALL ON public.device_primary_repair_requests TO service_role;

ALTER TABLE public.device_primary_repair_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner can read repair requests"
  ON public.device_primary_repair_requests
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Trigger function: handles primary loss
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_primary_device_loss()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count int;
  v_candidate    record;
  v_candidates   text[];
  v_stale_cutoff timestamptz := now() - interval '90 days';
BEGIN
  -- Only act when the row that was just changed used to be the active primary
  -- AND it is no longer an active primary.
  IF NOT (
    COALESCE(OLD.is_primary, false) = true
    AND COALESCE(OLD.is_active,  false) = true
    AND (
         COALESCE(NEW.is_active,  false) = false
      OR COALESCE(NEW.is_primary, false) = false
      OR NEW.revoked_at IS NOT NULL
    )
  ) THEN
    RETURN NEW;
  END IF;

  -- Already another active primary? Nothing to do.
  IF EXISTS (
    SELECT 1 FROM public.user_devices
    WHERE user_id = OLD.user_id
      AND is_active = true
      AND is_primary = true
      AND revoked_at IS NULL
      AND id <> OLD.id
  ) THEN
    RETURN NEW;
  END IF;

  -- Eligible candidates: active, not revoked, not stale, with a public key.
  SELECT count(*),
         array_agg(device_id ORDER BY last_seen_at DESC NULLS LAST)
    INTO v_active_count, v_candidates
  FROM public.user_devices
  WHERE user_id = OLD.user_id
    AND is_active = true
    AND revoked_at IS NULL
    AND COALESCE(device_public_key, '') <> ''
    AND (last_seen_at IS NULL OR last_seen_at > v_stale_cutoff)
    AND id <> OLD.id;

  IF v_active_count = 1 THEN
    -- Promote the single remaining device.
    SELECT * INTO v_candidate
    FROM public.user_devices
    WHERE user_id = OLD.user_id
      AND device_id = v_candidates[1]
    LIMIT 1;

    UPDATE public.user_devices
       SET is_primary = true,
           updated_at = now()
     WHERE id = v_candidate.id;

    -- Revoke any signatures emitted by the OLD primary so peers stop
    -- trusting companions signed by the dead root.
    UPDATE public.user_device_signatures
       SET revoked_at = now()
     WHERE user_id = OLD.user_id
       AND primary_device_id = OLD.device_id
       AND revoked_at IS NULL;

    -- Bump the device's signed-prekey epoch so peers re-fetch a fresh bundle
    -- and invalidate caches pointing at the dead primary.
    UPDATE public.device_signed_prekeys
       SET keys_epoch = greatest(keys_epoch + 1, spk_id + 1)
     WHERE user_id = OLD.user_id
       AND device_id = v_candidate.device_id
       AND is_active = true;

    INSERT INTO public.device_primary_repair_requests(user_id, reason, candidate_device_ids)
    VALUES (OLD.user_id, 'auto_promoted', ARRAY[v_candidate.device_id]);

  ELSIF v_active_count >= 2 THEN
    -- Ambiguous: require manual relink / approval. Log a pending request.
    INSERT INTO public.device_primary_repair_requests(user_id, reason, candidate_device_ids)
    VALUES (OLD.user_id, 'manual_relink_required', v_candidates);
  ELSE
    -- 0 eligible remaining: user must re-pair from scratch.
    INSERT INTO public.device_primary_repair_requests(user_id, reason, candidate_device_ids)
    VALUES (OLD.user_id, 'no_eligible_device', ARRAY[]::text[]);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_handle_primary_device_loss ON public.user_devices;
CREATE TRIGGER trg_handle_primary_device_loss
AFTER UPDATE OF is_active, is_primary, revoked_at ON public.user_devices
FOR EACH ROW
EXECUTE FUNCTION public.handle_primary_device_loss();
