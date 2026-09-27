-- Close the remaining high-risk SECURITY DEFINER and legacy Storage surfaces.
-- Client-facing helpers remain available only to their owner (or an admin where
-- explicitly required). Internal maintenance and ML helpers are service-only.

CREATE OR REPLACE FUNCTION public.get_onboarding_state(_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'onboarding_completed', p.onboarding_completed,
    'onboarding_step', p.onboarding_step,
    'has_interests', (p.interests IS NOT NULL AND pg_catalog.array_length(p.interests, 1) >= 3),
    'has_name', (p.name IS NOT NULL AND p.name <> '')
  )
  FROM public.profiles AS p
  WHERE p.user_id = _user_id
    AND (
      _user_id = auth.uid()
      OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role'
    );
$$;

CREATE OR REPLACE FUNCTION public.advance_onboarding_step(
  _user_id uuid,
  _expected_step smallint
)
RETURNS smallint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_step smallint;
BEGIN
  IF _user_id IS NULL OR (
    _user_id IS DISTINCT FROM auth.uid()
    AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT p.onboarding_step
    INTO current_step
  FROM public.profiles AS p
  WHERE p.user_id = _user_id;

  IF current_step IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF current_step <> _expected_step THEN
    RAISE EXCEPTION 'Step mismatch: expected %, got %', current_step, _expected_step;
  END IF;

  UPDATE public.profiles
  SET onboarding_step = current_step + 1
  WHERE user_id = _user_id;

  RETURN current_step + 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_onboarding(_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_step smallint;
  v_name text;
  v_interest_count integer;
BEGIN
  IF _user_id IS NULL OR (
    _user_id IS DISTINCT FROM auth.uid()
    AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT p.onboarding_step, p.name
    INTO v_step, v_name
  FROM public.profiles AS p
  WHERE p.user_id = _user_id;

  IF v_step IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF v_step < 2 THEN
    RAISE EXCEPTION 'Onboarding steps not completed (current: %)', v_step;
  END IF;

  IF v_name IS NULL OR v_name = '' THEN
    RAISE EXCEPTION 'Name is required';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_interest_count
  FROM public.user_interests AS ui
  WHERE ui.user_id = _user_id;

  IF v_interest_count < 3 THEN
    RAISE EXCEPTION 'At least 3 interests required (found: %)', v_interest_count;
  END IF;

  UPDATE public.profiles
  SET onboarding_completed = true,
      onboarding_step = 3
  WHERE user_id = _user_id;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_onboarding_state(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.advance_onboarding_step(uuid, smallint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.complete_onboarding(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_onboarding_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.advance_onboarding_step(uuid, smallint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_onboarding(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_parental_controls(p_user_id uuid)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  is_active boolean,
  is_minor boolean,
  allowed_categories text[],
  created_at timestamp with time zone,
  updated_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    pc.id,
    pc.user_id,
    pc.is_active,
    pc.is_minor,
    pc.allowed_categories,
    pc.created_at,
    pc.updated_at
  FROM public.parental_controls AS pc
  WHERE pc.user_id = p_user_id
    AND (
      p_user_id = auth.uid()
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
      OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role'
    );
$$;

CREATE OR REPLACE FUNCTION public.get_ai_data_sharing_enabled(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT ps.ai_data_sharing_enabled
      FROM public.privacy_settings AS ps
      WHERE ps.user_id = p_user_id
    ),
    true
  )
  WHERE p_user_id = auth.uid()
     OR public.has_role(auth.uid(), 'admin'::public.app_role)
     OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role';
$$;

CREATE OR REPLACE FUNCTION public.has_chat_pin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_user_id = auth.uid()
      OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role'
    THEN EXISTS (
      SELECT 1
      FROM public.user_chat_pins AS pins
      WHERE pins.user_id = p_user_id
    )
    ELSE false
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_parental_controls(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_ai_data_sharing_enabled(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_chat_pin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_parental_controls(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_ai_data_sharing_enabled(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_chat_pin(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.threat_shield_stats(window_minutes integer DEFAULT 60)
RETURNS TABLE(
  total bigint,
  banned bigint,
  penalized bigint,
  logged bigint,
  top_category text,
  last_block timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH base AS (
    SELECT td.*
    FROM public.threat_decisions AS td
    WHERE td.created_at > pg_catalog.now() - (window_minutes || ' minutes')::pg_catalog.interval
  ),
  cats AS (
    SELECT b.category, pg_catalog.count(*) AS c
    FROM base AS b
    WHERE b.action_taken IN ('ban', 'penalize')
    GROUP BY b.category
    ORDER BY c DESC
    LIMIT 1
  )
  SELECT
    (SELECT pg_catalog.count(*) FROM base),
    (SELECT pg_catalog.count(*) FROM base WHERE action_taken = 'ban'),
    (SELECT pg_catalog.count(*) FROM base WHERE action_taken = 'penalize'),
    (SELECT pg_catalog.count(*) FROM base WHERE action_taken = 'log'),
    (SELECT category FROM cats),
    (SELECT pg_catalog.max(created_at) FROM base WHERE action_taken IN ('ban', 'penalize'))
  WHERE public.has_role(auth.uid(), 'admin'::public.app_role)
     OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role';
$$;

CREATE OR REPLACE FUNCTION public.threat_shield_ml_stats()
RETURNS TABLE(
  decided_by_ml bigint,
  decided_by_gemini bigint,
  decided_by_regex bigint,
  total_samples bigint,
  positive_samples bigint,
  active_version integer,
  active_accuracy real,
  active_precision real,
  active_recall real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (SELECT pg_catalog.count(*) FROM public.threat_decisions WHERE decided_by IN ('ml', 'hybrid') AND created_at > pg_catalog.now() - '24 hours'::pg_catalog.interval),
    (SELECT pg_catalog.count(*) FROM public.threat_decisions WHERE decided_by = 'gemini' AND created_at > pg_catalog.now() - '24 hours'::pg_catalog.interval),
    (SELECT pg_catalog.count(*) FROM public.threat_decisions WHERE decided_by = 'regex' AND created_at > pg_catalog.now() - '24 hours'::pg_catalog.interval),
    (SELECT pg_catalog.count(*) FROM public.threat_training_samples),
    (SELECT pg_catalog.count(*) FROM public.threat_training_samples WHERE label = 1),
    (SELECT version FROM public.threat_model_weights WHERE active = true ORDER BY trained_at DESC LIMIT 1),
    (SELECT accuracy FROM public.threat_model_weights WHERE active = true ORDER BY trained_at DESC LIMIT 1),
    (SELECT precision_score FROM public.threat_model_weights WHERE active = true ORDER BY trained_at DESC LIMIT 1),
    (SELECT recall FROM public.threat_model_weights WHERE active = true ORDER BY trained_at DESC LIMIT 1)
  WHERE public.has_role(auth.uid(), 'admin'::public.app_role)
     OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role';
$$;

REVOKE EXECUTE ON FUNCTION public.threat_shield_stats(integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.threat_shield_ml_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.threat_shield_stats(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.threat_shield_ml_stats() TO authenticated, service_role;

-- These helpers either expose cross-user data, mutate privileged state, read
-- Vault secrets, or are called exclusively by server/cron code.
REVOKE EXECUTE ON FUNCTION public.is_user_minor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_build_post_embedding_text(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_build_user_embedding_text(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.threat_shield_active_model() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_ai_cache() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_behavior_signals() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_fingerprints() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_login_attempts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ddos_cleanup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_old_ai_engine_events() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_old_audit_logs() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_old_crypto_error_logs() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_old_feed_score_tamper_events() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_old_threat_decisions() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_login_rate_limit(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_login_attempt(text, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ddos_check_ip(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_compute_post_scores(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_refresh_creator_features_v8(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_embeddings_cron_tick() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.is_user_minor(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_build_post_embedding_text(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_build_user_embedding_text(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.threat_shield_active_model() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_ai_cache() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_behavior_signals() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_fingerprints() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_login_attempts() TO service_role;
GRANT EXECUTE ON FUNCTION public.ddos_cleanup() TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_old_ai_engine_events() TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_old_audit_logs() TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_old_crypto_error_logs() TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_old_feed_score_tamper_events() TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_old_threat_decisions() TO service_role;
GRANT EXECUTE ON FUNCTION public.check_login_rate_limit(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_login_attempt(text, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ddos_check_ip(text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_compute_post_scores(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_refresh_creator_features_v8(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_embeddings_cron_tick() TO service_role;

-- Some historical Lovable environments provision this cron wrapper outside
-- the migration chain. Keep it service-only when present without making a
-- clean database rebuild depend on that external object.
DO $email_queue_dispatch_privileges$
BEGIN
  IF pg_catalog.to_regprocedure('public.email_queue_dispatch()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.email_queue_dispatch() FROM PUBLIC, anon, authenticated;';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.email_queue_dispatch() TO service_role;';
  END IF;
END
$email_queue_dispatch_privileges$;

-- Legacy Supabase Storage policies were permissive OR-branches that allowed
-- any authenticated account to overwrite or delete another account's media.
DROP POLICY IF EXISTS "Authenticated users can upload product images" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their product images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their product images" ON storage.objects;
DROP POLICY IF EXISTS "Owners can upload their product images" ON storage.objects;
DROP POLICY IF EXISTS "Owners can update their product images" ON storage.objects;
DROP POLICY IF EXISTS "Owners can delete their product images" ON storage.objects;

CREATE POLICY "Owners can upload their product images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'products'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Owners can update their product images"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'products'
  AND auth.uid()::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'products'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Owners can delete their product images"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'products'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "Authenticated users can upload post images" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own post images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own post images" ON storage.objects;

CREATE POLICY "Users can upload their own post images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'post-images'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete their own post images"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'post-images'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
