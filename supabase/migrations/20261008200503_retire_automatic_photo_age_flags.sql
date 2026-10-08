BEGIN;

-- Retire only requests created by the former photo-age estimator. Manual
-- reports and every case with an uploaded identity document remain untouched.
WITH candidates AS MATERIALIZED (
  SELECT verification.id, verification.reported_user_id
  FROM public.identity_verifications AS verification
  JOIN public.profiles AS profile
    ON profile.user_id = verification.reported_user_id
  WHERE verification.reporter_id = verification.reported_user_id
    AND verification.reason LIKE 'Vérification d''âge automatique :%'
    AND verification.status IN ('pending', 'pending_verification')
    AND verification.id_document_url IS NULL
    AND profile.age_verification_status = 'flagged'
), reset_profiles AS (
  UPDATE public.profiles AS profile
  SET age_verified = false,
      age_verification_status = 'none',
      updated_at = pg_catalog.clock_timestamp()
  WHERE profile.user_id IN (SELECT candidate.reported_user_id FROM candidates AS candidate)
  RETURNING profile.user_id
), disable_automatic_parental_control AS (
  UPDATE public.parental_controls AS control
  SET is_active = false,
      is_minor = false,
      updated_at = pg_catalog.clock_timestamp()
  WHERE control.user_id IN (SELECT candidate.reported_user_id FROM candidates AS candidate)
  RETURNING control.user_id
)
UPDATE public.identity_verifications AS verification
SET status = 'deleted',
    auto_deleted = true,
    admin_note = pg_catalog.left(
      concat_ws(E'\n', nullif(verification.admin_note, ''), 'Ancienne estimation automatique sur photo retirée.'),
      2000
    ),
    updated_at = pg_catalog.clock_timestamp()
WHERE verification.id IN (SELECT candidate.id FROM candidates AS candidate);

-- A successful adult identity review must also remove a parental state that
-- originated from the retired automatic-photo workflow.
CREATE OR REPLACE FUNCTION public.admin_update_identity_verification(
  p_verification_id uuid,
  p_status text,
  p_admin_note text DEFAULT NULL,
  p_auto_deleted boolean DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reported_user_id uuid;
  v_automatic_photo_request boolean;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role)
     AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'administrator required' USING ERRCODE = '42501';
  END IF;

  IF p_verification_id IS NULL
     OR p_status NOT IN (
       'pending', 'pending_verification', 'document_submitted',
       'verified', 'rejected', 'deleted'
     )
     OR pg_catalog.length(COALESCE(p_admin_note, '')) > 2000 THEN
    RAISE EXCEPTION 'invalid verification update' USING ERRCODE = '22023';
  END IF;

  UPDATE public.identity_verifications AS verification
  SET status = p_status,
      admin_note = CASE
        WHEN p_admin_note IS NOT NULL THEN p_admin_note
        ELSE verification.admin_note
      END,
      auto_deleted = CASE
        WHEN p_auto_deleted IS NOT NULL THEN p_auto_deleted
        ELSE verification.auto_deleted
      END,
      verified_at = CASE
        WHEN p_status = 'verified' THEN pg_catalog.now()
        ELSE NULL
      END,
      updated_at = pg_catalog.now()
  WHERE verification.id = p_verification_id
  RETURNING verification.reported_user_id,
    verification.reporter_id = verification.reported_user_id
      AND verification.reason LIKE 'Vérification d''âge automatique :%'
  INTO v_reported_user_id, v_automatic_photo_request;

  IF v_reported_user_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.profiles
  SET age_verified = (p_status = 'verified'),
      age_verification_status = CASE
        WHEN p_status = 'verified' THEN 'verified'
        WHEN p_status = 'rejected' THEN 'rejected'
        WHEN p_status = 'deleted' THEN 'none'
        ELSE 'pending'
      END,
      updated_at = pg_catalog.now()
  WHERE user_id = v_reported_user_id;

  IF p_status = 'verified' AND v_automatic_photo_request THEN
    UPDATE public.parental_controls
    SET is_active = false,
        is_minor = false,
        updated_at = pg_catalog.clock_timestamp()
    WHERE user_id = v_reported_user_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_update_identity_verification(uuid, text, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_identity_verification(uuid, text, text, boolean)
  TO authenticated, service_role;

COMMIT;
