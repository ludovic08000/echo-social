-- Remove residual anonymous access from authenticated SECURITY DEFINER RPCs,
-- bind account-scoped helpers to the caller, and close public ML/write paths.

DROP FUNCTION IF EXISTS public.get_friend_suggestions(uuid, integer);

CREATE OR REPLACE FUNCTION public.get_friend_suggestions(
  target_user_id uuid,
  limit_count integer DEFAULT 10
)
RETURNS TABLE(
  user_id uuid,
  name text,
  avatar_url text,
  bio text,
  city text,
  created_at timestamp with time zone,
  profile_type text,
  mutual_friends_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF target_user_id IS NULL OR (
    target_user_id IS DISTINCT FROM auth.uid()
    AND NOT public.has_role(auth.uid(), 'admin'::public.app_role)
    AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF limit_count IS NULL OR limit_count < 1 OR limit_count > 50 THEN
    RAISE EXCEPTION 'invalid limit' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH my_profile AS (
    SELECT p.city AS my_city
    FROM public.profiles AS p
    WHERE p.user_id = target_user_id
  ),
  my_friends AS (
    SELECT CASE
      WHEN f.requester_id = target_user_id THEN f.addressee_id
      ELSE f.requester_id
    END AS friend_id
    FROM public.friendships AS f
    WHERE (f.requester_id = target_user_id OR f.addressee_id = target_user_id)
      AND f.status = 'accepted'
  ),
  pending_requests AS (
    SELECT CASE
      WHEN f.requester_id = target_user_id THEN f.addressee_id
      ELSE f.requester_id
    END AS pending_id
    FROM public.friendships AS f
    WHERE f.requester_id = target_user_id OR f.addressee_id = target_user_id
  ),
  friends_of_friends AS (
    SELECT
      CASE
        WHEN f.requester_id = mf.friend_id THEN f.addressee_id
        ELSE f.requester_id
      END AS fof_id,
      pg_catalog.count(*) AS mutual_count
    FROM my_friends AS mf
    JOIN public.friendships AS f
      ON (f.requester_id = mf.friend_id OR f.addressee_id = mf.friend_id)
     AND f.status = 'accepted'
    WHERE CASE
      WHEN f.requester_id = mf.friend_id THEN f.addressee_id
      ELSE f.requester_id
    END <> target_user_id
      AND CASE
        WHEN f.requester_id = mf.friend_id THEN f.addressee_id
        ELSE f.requester_id
      END NOT IN (SELECT friend_id FROM my_friends)
      AND CASE
        WHEN f.requester_id = mf.friend_id THEN f.addressee_id
        ELSE f.requester_id
      END NOT IN (SELECT pending_id FROM pending_requests)
    GROUP BY fof_id
  )
  SELECT
    p.user_id,
    p.name,
    p.avatar_url,
    p.bio,
    CASE
      WHEN COALESCE(p.field_visibility ->> 'city', 'public') = 'public'
      THEN p.city
      ELSE NULL
    END AS city,
    p.created_at,
    p.profile_type,
    COALESCE(fof.mutual_count, 0)
  FROM public.profiles AS p
  CROSS JOIN my_profile AS mp
  LEFT JOIN friends_of_friends AS fof ON fof.fof_id = p.user_id
  WHERE p.user_id <> target_user_id
    AND p.user_id NOT IN (SELECT friend_id FROM my_friends)
    AND p.user_id NOT IN (SELECT pending_id FROM pending_requests)
  ORDER BY
    (
      COALESCE(fof.mutual_count, 0) * 3
      + CASE
          WHEN mp.my_city IS NOT NULL
            AND p.city IS NOT NULL
            AND pg_catalog.lower(pg_catalog.btrim(p.city)) = pg_catalog.lower(pg_catalog.btrim(mp.my_city))
          THEN 2
          ELSE 0
        END
    ) DESC,
    p.created_at DESC
  LIMIT limit_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.ml_record_watch_time(
  p_post_id uuid,
  p_total_ms numeric,
  p_sample_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL
     AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_post_id IS NULL
     OR p_sample_count IS NULL
     OR p_sample_count < 1
     OR p_sample_count > 500
     OR p_total_ms IS NULL
     OR p_total_ms < 0
     OR p_total_ms > (p_sample_count::numeric * 86400000::numeric) THEN
    RAISE EXCEPTION 'invalid watch-time sample' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.posts AS p WHERE p.id = p_post_id
  ) THEN
    RAISE EXCEPTION 'post not found' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ml_post_features (
    post_id,
    avg_watch_time_ms,
    watch_sample_count,
    updated_at
  )
  VALUES (
    p_post_id,
    p_total_ms / GREATEST(p_sample_count, 1),
    p_sample_count,
    pg_catalog.now()
  )
  ON CONFLICT (post_id) DO UPDATE
  SET avg_watch_time_ms = (
        COALESCE(public.ml_post_features.avg_watch_time_ms, 0)
          * COALESCE(public.ml_post_features.watch_sample_count, 0)
        + EXCLUDED.avg_watch_time_ms * p_sample_count
      ) / NULLIF(
        COALESCE(public.ml_post_features.watch_sample_count, 0) + p_sample_count,
        0
      ),
      watch_sample_count = COALESCE(public.ml_post_features.watch_sample_count, 0) + p_sample_count,
      updated_at = pg_catalog.now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_friend_suggestions(uuid, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.ml_record_watch_time(uuid, numeric, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.request_message_refanout(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_friend_suggestions(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ml_record_watch_time(uuid, numeric, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_message_refanout(uuid, uuid, text) TO authenticated, service_role;

-- Raw internal trust/wellbeing scores are not public profile fields.
REVOKE EXECUTE ON FUNCTION public.get_public_trust_score(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_public_wellbeing_score(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_trust_score(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_public_wellbeing_score(uuid) TO service_role;

-- These recommendation RPCs are browser-facing but never anonymous. Their
-- SECURITY DEFINER bodies need explicit role grants because CREATE FUNCTION
-- otherwise grants EXECUTE to PUBLIC.
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
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon',
      signature
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role',
      signature
    );
  END LOOP;
END;
$$;

-- Close anonymous access on all remaining account-scoped SECURITY DEFINER
-- functions that already contain an explicit auth guard. RLS helper functions
-- are excluded because policies may evaluate them for a public SELECT.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND pg_catalog.pg_get_function_result(p.oid) <> 'trigger'
      AND p.proname NOT IN ('has_role', 'can_view_order', 'can_view_order_item')
      AND (
        POSITION('auth.uid(' IN pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid))) > 0
        OR POSITION('auth.jwt(' IN pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid))) > 0
        OR POSITION('has_role(' IN pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid))) > 0
      )
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon',
      target.signature
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role',
      target.signature
    );
  END LOOP;
END;
$$;

-- AI telemetry is written by trusted server code, not arbitrary clients.
DROP POLICY IF EXISTS "Service can insert ai_metrics_log" ON public.ai_metrics_log;
DROP POLICY IF EXISTS "Service role can insert ai_metrics_log" ON public.ai_metrics_log;
CREATE POLICY "Service role can insert ai_metrics_log"
ON public.ai_metrics_log
FOR INSERT
TO service_role
WITH CHECK (true);

-- Model internals and vector embeddings must not be downloadable through the
-- public Data API. Admin UI remains functional; service_role bypasses RLS.
DROP POLICY IF EXISTS "Anyone can read config" ON public.ml_model_config;
DROP POLICY IF EXISTS "Admins manage config" ON public.ml_model_config;
CREATE POLICY "Admins manage config"
ON public.ml_model_config
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Anyone can read post features" ON public.ml_post_features;
DROP POLICY IF EXISTS "Admins can manage post features" ON public.ml_post_features;
CREATE POLICY "Admins can manage post features"
ON public.ml_post_features
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Anyone can view post embeddings" ON public.ml_post_embeddings;
DROP POLICY IF EXISTS "Service role manages post embeddings" ON public.ml_post_embeddings;
CREATE POLICY "Service role manages post embeddings"
ON public.ml_post_embeddings
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "creator_features readable" ON public.ml_creator_features;
DROP POLICY IF EXISTS "creator_features admin manage" ON public.ml_creator_features;
CREATE POLICY "Creator features admin manage"
ON public.ml_creator_features
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Anyone can read active models" ON public.ml_models;
DROP POLICY IF EXISTS "Admins manage models" ON public.ml_models;
CREATE POLICY "Admins manage models"
ON public.ml_models
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Keep public reads for public media, but writes require an authenticated user
-- and updates cannot move an object into another account's folder.
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
CREATE POLICY "Users can upload their own avatar"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users can update their own avatar"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'avatars'
  AND auth.uid()::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'avatars'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "Users can upload their own backgrounds" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own backgrounds" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own backgrounds" ON storage.objects;
CREATE POLICY "Users can upload their own backgrounds"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'backgrounds'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users can update their own backgrounds"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'backgrounds'
  AND auth.uid()::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'backgrounds'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users can delete their own backgrounds"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'backgrounds'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "Users can upload videos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their videos" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their videos" ON storage.objects;
CREATE POLICY "Users can upload videos"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'videos'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users can update their videos"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'videos'
  AND auth.uid()::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'videos'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users can delete their videos"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'videos'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
