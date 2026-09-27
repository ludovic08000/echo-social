-- Close the remaining browser-reachable privilege and privacy gaps found by
-- the final manual SECURITY DEFINER / view ACL audit.

-- These helpers are required by RLS, but callers must not be able to use them
-- as cross-account membership or role-enumeration oracles.
CREATE OR REPLACE FUNCTION public.has_role(
  _user_id uuid,
  _role public.app_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN EXISTS (
      SELECT 1
      FROM public.user_roles AS role_row
      WHERE role_row.user_id = _user_id
        AND role_row.role = _role
    )
    WHEN auth.uid() IS NOT NULL AND _user_id = auth.uid() THEN EXISTS (
      SELECT 1
      FROM public.user_roles AS role_row
      WHERE role_row.user_id = auth.uid()
        AND role_row.role = _role
    )
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_conversation_participant(
  conv_id uuid,
  uid uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN EXISTS (
      SELECT 1
      FROM public.conversation_participants AS participant
      WHERE participant.conversation_id = conv_id
        AND participant.user_id = uid
    )
    WHEN auth.uid() IS NOT NULL AND uid = auth.uid() THEN EXISTS (
      SELECT 1
      FROM public.conversation_participants AS participant
      WHERE participant.conversation_id = conv_id
        AND participant.user_id = auth.uid()
    )
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_restricted_by(
  p_owner_id uuid,
  p_viewer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN EXISTS (
      SELECT 1
      FROM public.restricted_friends AS restriction
      WHERE restriction.user_id = p_owner_id
        AND restriction.restricted_user_id = p_viewer_id
    )
    WHEN auth.uid() IS NOT NULL AND p_viewer_id = auth.uid() THEN EXISTS (
      SELECT 1
      FROM public.restricted_friends AS restriction
      WHERE restriction.user_id = p_owner_id
        AND restriction.restricted_user_id = auth.uid()
    )
    ELSE false
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_restricted_by(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_restricted_by(uuid, uuid)
  TO anon, authenticated, service_role;

-- The browser only needs scores for its own account. Keep the historical
-- arbitrary-user functions for trusted jobs and expose a caller-bound facade.
CREATE OR REPLACE FUNCTION public.ml_pareto_score_batch_for_current_user(
  p_post_ids uuid[]
)
RETURNS TABLE(post_id uuid, score numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_post_ids IS NULL OR pg_catalog.cardinality(p_post_ids) = 0 THEN
    RETURN;
  END IF;

  IF pg_catalog.cardinality(p_post_ids) > 200
     OR pg_catalog.array_position(p_post_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid post batch' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT scored.post_id, scored.score
  FROM public.ml_pareto_score_batch(v_user_id, p_post_ids) AS scored;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ml_pareto_score_batch_for_current_user(uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ml_pareto_score_batch_for_current_user(uuid[])
  TO authenticated;

DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.ml_cold_start_feed(uuid,integer)',
    'public.ml_find_similar_posts(uuid,integer)',
    'public.ml_is_cold_start(uuid)',
    'public.ml_pareto_score(uuid,uuid,numeric,numeric,numeric)',
    'public.ml_pareto_score_batch(uuid,uuid[])',
    'public.ml_score_post(uuid,uuid)',
    'public.ml_score_post_v2(uuid,uuid)',
    'public.ml_score_post_v3(uuid,uuid)',
    'public.ml_score_post_v4(uuid,uuid)',
    'public.ml_score_post_v5(uuid,uuid)'
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      signature
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      signature
    );
  END LOOP;
END;
$$;

-- Retire the legacy contact matcher that accepts a caller-supplied user ID.
-- The active one-argument overload derives the account from auth.uid().
REVOKE EXECUTE ON FUNCTION public.match_contacts_by_phone(uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_contacts_by_phone(uuid, text[])
  TO service_role;

-- Views keep read-only access where they are part of a public surface. The
-- training-label view contains account behaviour and remains server-only.
REVOKE ALL PRIVILEGES ON TABLE public.anonymous_wall_messages_public
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.anonymous_wall_messages_safe
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.anonymous_wall_public
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.anonymous_wall_messages_public TO anon, authenticated;
GRANT SELECT ON TABLE public.anonymous_wall_messages_safe TO anon, authenticated;
GRANT SELECT ON TABLE public.anonymous_wall_public TO anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.public_profiles
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_profiles TO service_role;

REVOKE ALL PRIVILEGES ON TABLE public.ml_training_labels_v8
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ml_training_labels_v8 TO service_role;

-- Keep profile verification and the durable age decision synchronized in both
-- directions. A rejected/deleted/reopened verification must revoke an earlier
-- positive age flag instead of leaving stale trusted state behind.
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
  RETURNING verification.reported_user_id INTO v_reported_user_id;

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

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_update_identity_verification(uuid, text, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_identity_verification(uuid, text, text, boolean)
  TO authenticated, service_role;

-- Storage enforces the same identity-document contract as the clients.
UPDATE storage.buckets
SET public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY[
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf'
    ]::text[]
WHERE id = 'id-documents';
