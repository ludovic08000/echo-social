-- =====================================================================
-- For Sure RecSys v8
-- Embedding retrieval + final rerank + A/B telemetry foundation.
--
-- This migration is additive: v7 functions remain available and the client can
-- fall back to get_feed_posts when this RPC is not deployed yet.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE public.ml_post_features
  ADD COLUMN IF NOT EXISTS embedding_text text,
  ADD COLUMN IF NOT EXISTS creator_id uuid,
  ADD COLUMN IF NOT EXISTS content_sensitivity_score numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repetitive_score numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS novelty_score numeric NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS embedding_source text,
  ADD COLUMN IF NOT EXISTS last_embedding_requested_at timestamptz;

ALTER TABLE public.ml_user_profiles
  ADD COLUMN IF NOT EXISTS creator_affinity jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS negative_topic_weights jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.ml_creator_features (
  creator_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  embedding vector(256),
  quality_score numeric NOT NULL DEFAULT 0.5,
  novelty_score numeric NOT NULL DEFAULT 0.5,
  fatigue_score numeric NOT NULL DEFAULT 0,
  total_posts integer NOT NULL DEFAULT 0,
  avg_watch_time_ms numeric NOT NULL DEFAULT 0,
  negative_feedback_rate numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ml_creator_features ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ml_creator_features'
      AND policyname = 'creator_features readable'
  ) THEN
    CREATE POLICY "creator_features readable"
      ON public.ml_creator_features FOR SELECT
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ml_creator_features'
      AND policyname = 'creator_features admin manage'
  ) THEN
    CREATE POLICY "creator_features admin manage"
      ON public.ml_creator_features FOR ALL
      USING (has_role(auth.uid(), 'admin'::app_role))
      WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ml_creator_features_embedding
  ON public.ml_creator_features USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 64);

CREATE INDEX IF NOT EXISTS idx_ml_post_features_creator
  ON public.ml_post_features(creator_id);

CREATE INDEX IF NOT EXISTS idx_ml_post_features_safety
  ON public.ml_post_features(content_sensitivity_score, repetitive_score);

CREATE TABLE IF NOT EXISTS public.ml_embedding_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('post', 'user', 'creator')),
  target_id uuid NOT NULL,
  source_text text,
  priority integer NOT NULL DEFAULT 50,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, status)
);

CREATE INDEX IF NOT EXISTS idx_ml_embedding_jobs_queue
  ON public.ml_embedding_jobs(status, priority DESC, created_at ASC);

ALTER TABLE public.ml_embedding_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ml_embedding_jobs'
      AND policyname = 'embedding_jobs admin read'
  ) THEN
    CREATE POLICY "embedding_jobs admin read"
      ON public.ml_embedding_jobs FOR SELECT
      USING (has_role(auth.uid(), 'admin'::app_role));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ml_embedding_jobs'
      AND policyname = 'embedding_jobs admin manage'
  ) THEN
    CREATE POLICY "embedding_jobs admin manage"
      ON public.ml_embedding_jobs FOR ALL
      USING (has_role(auth.uid(), 'admin'::app_role))
      WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ml_feed_experiments (
  key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  traffic_split integer NOT NULL DEFAULT 50 CHECK (traffic_split BETWEEN 0 AND 100),
  variant_a jsonb NOT NULL DEFAULT '{}'::jsonb,
  variant_b jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_metric text NOT NULL DEFAULT 'retention',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ml_feed_experiments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ml_feed_experiments'
      AND policyname = 'active_feed_experiments_readable'
  ) THEN
    CREATE POLICY "active_feed_experiments_readable"
      ON public.ml_feed_experiments FOR SELECT
      USING (status = 'running' OR has_role(auth.uid(), 'admin'::app_role));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ml_feed_experiments'
      AND policyname = 'feed_experiments_admin_manage'
  ) THEN
    CREATE POLICY "feed_experiments_admin_manage"
      ON public.ml_feed_experiments FOR ALL
      USING (has_role(auth.uid(), 'admin'::app_role))
      WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ml_feed_experiment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  experiment_key text NOT NULL DEFAULT 'recsys_v8_main',
  variant text NOT NULL CHECK (variant IN ('a', 'b')),
  post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN (
      'view', 'impression', 'click', 'dwell_medium', 'dwell_long',
      'watch_complete', 'like', 'comment', 'share', 'save',
      'skip_fast', 'not_interested', 'hide', 'report'
    )
  ),
  surface text NOT NULL DEFAULT 'feed',
  dwell_ms integer,
  weight numeric NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_feed_exp_events_user_created
  ON public.ml_feed_experiment_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ml_feed_exp_events_post_type
  ON public.ml_feed_experiment_events(post_id, event_type, created_at DESC);

ALTER TABLE public.ml_feed_experiment_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ml_feed_experiment_events'
      AND policyname = 'feed_exp_events_insert_own'
  ) THEN
    CREATE POLICY "feed_exp_events_insert_own"
      ON public.ml_feed_experiment_events FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ml_feed_experiment_events'
      AND policyname = 'feed_exp_events_read_own_or_admin'
  ) THEN
    CREATE POLICY "feed_exp_events_read_own_or_admin"
      ON public.ml_feed_experiment_events FOR SELECT
      USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role));
  END IF;
END $$;

INSERT INTO public.ml_feed_experiments (
  key,
  status,
  traffic_split,
  variant_a,
  variant_b,
  target_metric
)
VALUES (
  'recsys_v8_main',
  'running',
  50,
  '{
    "retrieval_weight": 0.24,
    "exploration_weight": 0.04,
    "diversity_author_cap": 2,
    "new_creator_boost": 0.05
  }'::jsonb,
  '{
    "retrieval_weight": 0.34,
    "exploration_weight": 0.08,
    "diversity_author_cap": 1,
    "new_creator_boost": 0.10
  }'::jsonb,
  'watch_complete_rate'
)
ON CONFLICT (key) DO UPDATE
SET status = EXCLUDED.status,
    traffic_split = EXCLUDED.traffic_split,
    variant_a = EXCLUDED.variant_a,
    variant_b = EXCLUDED.variant_b,
    target_metric = EXCLUDED.target_metric,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.ml_recsys_v8_assignment(
  p_user_id uuid,
  p_experiment_key text DEFAULT 'recsys_v8_main'
)
RETURNS TABLE (
  experiment_key text,
  variant text,
  retrieval_weight numeric,
  exploration_weight numeric,
  diversity_author_cap integer,
  new_creator_boost numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_exp public.ml_feed_experiments%ROWTYPE;
  v_bucket integer := 0;
  v_cfg jsonb;
BEGIN
  SELECT *
  INTO v_exp
  FROM public.ml_feed_experiments
  WHERE key = p_experiment_key
    AND status = 'running';

  IF NOT FOUND THEN
    experiment_key := p_experiment_key;
    variant := 'a';
    retrieval_weight := 0.24;
    exploration_weight := 0.04;
    diversity_author_cap := 2;
    new_creator_boost := 0.05;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_user_id IS NULL THEN
    v_bucket := 0;
  ELSE
    v_bucket := get_byte(
      decode(substr(md5(v_user_id::text || ':' || p_experiment_key), 1, 2), 'hex'),
      0
    ) % 100;
  END IF;

  IF v_bucket < v_exp.traffic_split THEN
    variant := 'b';
    v_cfg := v_exp.variant_b;
  ELSE
    variant := 'a';
    v_cfg := v_exp.variant_a;
  END IF;

  experiment_key := v_exp.key;
  retrieval_weight := COALESCE((v_cfg->>'retrieval_weight')::numeric, 0.24);
  exploration_weight := COALESCE((v_cfg->>'exploration_weight')::numeric, 0.04);
  diversity_author_cap := COALESCE((v_cfg->>'diversity_author_cap')::integer, 2);
  new_creator_boost := COALESCE((v_cfg->>'new_creator_boost')::numeric, 0.05);
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.ml_recsys_v8_assignment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ml_recsys_v8_assignment(uuid, text) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.ml_build_post_embedding_text(p_post_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT trim(concat_ws(
    E'\n',
    COALESCE(p.body, ''),
    CASE
      WHEN COALESCE(array_length(f.hashtags, 1), 0) > 0
        THEN array_to_string(f.hashtags, ' ')
      ELSE ''
    END,
    CASE
      WHEN COALESCE(array_length(f.topics, 1), 0) > 0
        THEN array_to_string(f.topics, ' ')
      ELSE ''
    END,
    COALESCE(pr.name, '')
  ))
  FROM public.posts p
  LEFT JOIN public.ml_post_features f ON f.post_id = p.id
  LEFT JOIN public.profiles pr ON pr.user_id = p.user_id
  WHERE p.id = p_post_id
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.ml_build_post_embedding_text(uuid) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.ml_build_user_embedding_text(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT trim(concat_ws(
    E'\n',
    COALESCE(pr.name, ''),
    COALESCE(pr.bio, ''),
    COALESCE((
      SELECT string_agg(ui.interest_value, ' ' ORDER BY ui.weight DESC NULLS LAST)
      FROM public.user_interests ui
      WHERE ui.user_id = p_user_id
      LIMIT 80
    ), ''),
    COALESCE((
      SELECT string_agg(tag, ' ')
      FROM (
        SELECT DISTINCT lower(h) AS tag
        FROM public.ml_interactions mi
        JOIN public.ml_post_features f ON f.post_id = mi.post_id
        CROSS JOIN LATERAL unnest(COALESCE(f.hashtags, ARRAY[]::text[])) h
        WHERE mi.user_id = p_user_id
          AND mi.created_at > now() - interval '90 days'
          AND mi.signal_type IN ('dwell_long', 'watch_complete', 'like', 'comment', 'share', 'save')
        LIMIT 80
      ) tags
    ), '')
  ))
  FROM public.profiles pr
  WHERE pr.user_id = p_user_id
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.ml_build_user_embedding_text(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ml_queue_post_embedding(p_post_id uuid, p_priority integer DEFAULT 50)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_text text;
  v_author uuid;
BEGIN
  SELECT p.user_id, public.ml_build_post_embedding_text(p_post_id)
  INTO v_author, v_text
  FROM public.posts p
  WHERE p.id = p_post_id;

  IF v_author IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.ml_embedding_jobs (
    target_type,
    target_id,
    source_text,
    priority,
    requested_by
  )
  VALUES (
    'post',
    p_post_id,
    v_text,
    GREATEST(0, LEAST(COALESCE(p_priority, 50), 100)),
    auth.uid()
  )
  ON CONFLICT (target_type, target_id, status)
  DO UPDATE SET
    source_text = EXCLUDED.source_text,
    priority = GREATEST(public.ml_embedding_jobs.priority, EXCLUDED.priority),
    updated_at = now();

  UPDATE public.ml_post_features
  SET embedding_text = v_text,
      creator_id = v_author,
      last_embedding_requested_at = now()
  WHERE post_id = p_post_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.ml_queue_post_embedding(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ml_queue_post_embedding(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.ml_queue_user_embedding(p_user_id uuid DEFAULT NULL, p_priority integer DEFAULT 50)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(p_user_id, auth.uid());
  v_text text;
BEGIN
  IF v_user_id IS NULL OR (auth.uid() IS NOT NULL AND v_user_id <> auth.uid() AND NOT has_role(auth.uid(), 'admin'::app_role)) THEN
    RETURN false;
  END IF;

  v_text := public.ml_build_user_embedding_text(v_user_id);
  IF v_text IS NULL OR length(trim(v_text)) = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.ml_embedding_jobs (
    target_type,
    target_id,
    source_text,
    priority,
    requested_by
  )
  VALUES (
    'user',
    v_user_id,
    v_text,
    GREATEST(0, LEAST(COALESCE(p_priority, 50), 100)),
    auth.uid()
  )
  ON CONFLICT (target_type, target_id, status)
  DO UPDATE SET
    source_text = EXCLUDED.source_text,
    priority = GREATEST(public.ml_embedding_jobs.priority, EXCLUDED.priority),
    updated_at = now();

  UPDATE public.ml_user_profiles
  SET embedding_updated_at = COALESCE(embedding_updated_at, now())
  WHERE user_id = v_user_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.ml_queue_user_embedding(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ml_queue_user_embedding(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.ml_refresh_creator_features_v8(p_creator_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_total_posts integer := 0;
  v_avg_watch numeric := 0;
  v_negative_rate numeric := 0;
  v_quality numeric := 0.5;
  v_novelty numeric := 0.5;
BEGIN
  IF p_creator_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT COUNT(*)::integer
  INTO v_total_posts
  FROM public.posts
  WHERE user_id = p_creator_id
    AND created_at > now() - interval '180 days';

  SELECT
    COALESCE(AVG(f.avg_watch_time_ms), 0),
    COALESCE(
      SUM(f.negative_count)::numeric / GREATEST(1, SUM(f.positive_count + f.negative_count)),
      0
    )
  INTO v_avg_watch, v_negative_rate
  FROM public.posts p
  LEFT JOIN public.ml_post_features f ON f.post_id = p.id
  WHERE p.user_id = p_creator_id
    AND p.created_at > now() - interval '90 days';

  v_quality := LEAST(1.0, GREATEST(0.0,
    0.45
    + LEAST(0.30, COALESCE(v_avg_watch, 0) / 40000.0)
    - LEAST(0.35, COALESCE(v_negative_rate, 0) * 0.70)
  ));

  v_novelty := LEAST(1.0, GREATEST(0.0,
    CASE
      WHEN v_total_posts < 5 THEN 0.75
      WHEN v_total_posts < 20 THEN 0.62
      ELSE 0.48
    END
  ));

  INSERT INTO public.ml_creator_features (
    creator_id,
    quality_score,
    novelty_score,
    fatigue_score,
    total_posts,
    avg_watch_time_ms,
    negative_feedback_rate,
    updated_at
  )
  VALUES (
    p_creator_id,
    v_quality,
    v_novelty,
    LEAST(1.0, COALESCE(v_negative_rate, 0) * 1.2),
    COALESCE(v_total_posts, 0),
    COALESCE(v_avg_watch, 0),
    COALESCE(v_negative_rate, 0),
    now()
  )
  ON CONFLICT (creator_id) DO UPDATE SET
    quality_score = EXCLUDED.quality_score,
    novelty_score = EXCLUDED.novelty_score,
    fatigue_score = EXCLUDED.fatigue_score,
    total_posts = EXCLUDED.total_posts,
    avg_watch_time_ms = EXCLUDED.avg_watch_time_ms,
    negative_feedback_rate = EXCLUDED.negative_feedback_rate,
    updated_at = now();

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.ml_refresh_creator_features_v8(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ml_refresh_creator_features_v8(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ml_retrieve_feed_candidates_v8(
  p_user_id uuid,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  post_id uuid,
  retrieval_source text,
  retrieval_score numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_limit integer := GREATEST(50, LEAST(COALESCE(p_limit, 500), 800));
  v_user_emb_768 vector(768);
  v_user_emb_256 vector(256);
  v_interests text[];
BEGIN
  IF v_user_id IS NOT NULL THEN
    SELECT embedding INTO v_user_emb_768
    FROM public.ml_user_profiles
    WHERE user_id = v_user_id;

    SELECT embedding INTO v_user_emb_256
    FROM public.ml_user_embeddings
    WHERE user_id = v_user_id;

    SELECT COALESCE(array_agg(lower(interest_value)), '{}')
    INTO v_interests
    FROM (
      SELECT interest_value
      FROM public.user_interests
      WHERE user_id = v_user_id
      ORDER BY weight DESC NULLS LAST
      LIMIT 80
    ) i;
  ELSE
    v_interests := '{}';
  END IF;

  RETURN QUERY
  WITH blocked AS (
    SELECT mi.post_id
    FROM public.ml_interactions mi
    WHERE mi.user_id = v_user_id
      AND mi.created_at > now() - interval '90 days'
      AND mi.signal_type IN ('hide', 'not_interested', 'report')
  ),
  recent AS (
    SELECT
      p.id AS post_id,
      'recent'::text AS retrieval_source,
      LEAST(1.0, POWER(0.5, GREATEST(0.05, EXTRACT(EPOCH FROM (now() - p.created_at)) / 3600.0) / 18.0))::numeric AS retrieval_score
    FROM public.posts p
    WHERE (p.expires_at IS NULL OR p.expires_at > now())
      AND p.created_at > now() - interval '60 days'
      AND (v_user_id IS NULL OR p.id NOT IN (SELECT post_id FROM blocked))
    ORDER BY p.created_at DESC
    LIMIT 220
  ),
  social AS (
    SELECT
      p.id AS post_id,
      'social'::text AS retrieval_source,
      (0.72 + LEAST(0.24, LN(1 + COALESCE(p.likes_count, 0) + COALESCE(p.comments_count, 0) * 2) / 18.0))::numeric AS retrieval_score
    FROM public.posts p
    WHERE v_user_id IS NOT NULL
      AND (p.expires_at IS NULL OR p.expires_at > now())
      AND p.created_at > now() - interval '90 days'
      AND EXISTS (
        SELECT 1
        FROM public.friendships fr
        WHERE fr.status = 'accepted'
          AND (
            (fr.requester_id = v_user_id AND fr.addressee_id = p.user_id)
            OR (fr.addressee_id = v_user_id AND fr.requester_id = p.user_id)
          )
      )
      AND p.id NOT IN (SELECT post_id FROM blocked)
    ORDER BY p.created_at DESC
    LIMIT 160
  ),
  interest AS (
    SELECT
      p.id AS post_id,
      'interest'::text AS retrieval_source,
      LEAST(1.0, 0.58 + COUNT(*)::numeric * 0.10)::numeric AS retrieval_score
    FROM public.posts p
    LEFT JOIN public.ml_post_features f ON f.post_id = p.id
    WHERE v_user_id IS NOT NULL
      AND COALESCE(array_length(v_interests, 1), 0) > 0
      AND (p.expires_at IS NULL OR p.expires_at > now())
      AND p.created_at > now() - interval '120 days'
      AND p.id NOT IN (SELECT post_id FROM blocked)
      AND (
        EXISTS (
          SELECT 1
          FROM unnest(v_interests) i
          WHERE position(i IN lower(COALESCE(p.body, ''))) > 0
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(f.hashtags, ARRAY[]::text[])) h
          WHERE lower(h) = ANY(v_interests)
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(f.topics, ARRAY[]::text[])) t
          WHERE lower(t) = ANY(v_interests)
        )
      )
    GROUP BY p.id
    ORDER BY retrieval_score DESC, p.created_at DESC
    LIMIT 180
  ),
  semantic_768 AS (
    SELECT
      f.post_id,
      'semantic_768'::text AS retrieval_source,
      GREATEST(0.0, LEAST(1.0, ((1 - (f.embedding <=> v_user_emb_768)) + 1.0) / 2.0))::numeric AS retrieval_score
    FROM public.ml_post_features f
    JOIN public.posts p ON p.id = f.post_id
    WHERE v_user_emb_768 IS NOT NULL
      AND f.embedding IS NOT NULL
      AND (p.expires_at IS NULL OR p.expires_at > now())
      AND p.id NOT IN (SELECT post_id FROM blocked)
    ORDER BY f.embedding <=> v_user_emb_768
    LIMIT 220
  ),
  two_tower_256 AS (
    SELECT
      e.post_id,
      'two_tower_256'::text AS retrieval_source,
      GREATEST(0.0, LEAST(1.0, ((1 - (e.embedding <=> v_user_emb_256)) + 1.0) / 2.0))::numeric AS retrieval_score
    FROM public.ml_post_embeddings e
    JOIN public.posts p ON p.id = e.post_id
    WHERE v_user_emb_256 IS NOT NULL
      AND e.embedding IS NOT NULL
      AND (p.expires_at IS NULL OR p.expires_at > now())
      AND p.id NOT IN (SELECT post_id FROM blocked)
    ORDER BY e.embedding <=> v_user_emb_256
    LIMIT 220
  ),
  cold_start AS (
    SELECT
      p.id AS post_id,
      'cold_start'::text AS retrieval_source,
      0.54::numeric AS retrieval_score
    FROM public.posts p
    LEFT JOIN public.ml_post_features f ON f.post_id = p.id
    WHERE (p.expires_at IS NULL OR p.expires_at > now())
      AND p.created_at > now() - interval '24 hours'
      AND (COALESCE(p.likes_count, 0) + COALESCE(p.comments_count, 0) + COALESCE(f.watch_sample_count, 0)) < 12
      AND (v_user_id IS NULL OR p.id NOT IN (SELECT post_id FROM blocked))
    ORDER BY p.created_at DESC
    LIMIT 100
  ),
  unioned AS (
    SELECT * FROM recent
    UNION ALL SELECT * FROM social
    UNION ALL SELECT * FROM interest
    UNION ALL SELECT * FROM semantic_768
    UNION ALL SELECT * FROM two_tower_256
    UNION ALL SELECT * FROM cold_start
  ),
  reduced AS (
    SELECT
      u.post_id,
      (array_agg(u.retrieval_source ORDER BY u.retrieval_score DESC))[1] AS retrieval_source,
      MAX(u.retrieval_score)::numeric AS retrieval_score
    FROM unioned u
    GROUP BY u.post_id
  )
  SELECT r.post_id, r.retrieval_source, r.retrieval_score
  FROM reduced r
  ORDER BY r.retrieval_score DESC
  LIMIT v_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.ml_retrieve_feed_candidates_v8(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ml_retrieve_feed_candidates_v8(uuid, integer) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.get_feed_posts_v8(
  p_user_id uuid,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  body text,
  image_url text,
  created_at timestamptz,
  expires_at timestamptz,
  likes_count integer,
  comments_count integer,
  author_name text,
  author_avatar text,
  author_mood text,
  user_reaction text,
  is_friend boolean,
  final_score numeric,
  rank_reason text,
  experiment_variant text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 25), 50));
  v_offset integer := GREATEST(0, COALESCE(p_offset, 0));
  v_candidate_ids uuid[];
  v_assignment record;
BEGIN
  SELECT *
  INTO v_assignment
  FROM public.ml_recsys_v8_assignment(v_user_id, 'recsys_v8_main')
  LIMIT 1;

  SELECT array_agg(c.post_id ORDER BY c.retrieval_score DESC)
  INTO v_candidate_ids
  FROM public.ml_retrieve_feed_candidates_v8(v_user_id, 500) c;

  IF v_candidate_ids IS NULL OR array_length(v_candidate_ids, 1) IS NULL THEN
    RETURN QUERY
    SELECT
      g.id, g.user_id, g.body, g.image_url, g.created_at, g.expires_at,
      g.likes_count, g.comments_count, g.author_name, g.author_avatar,
      g.author_mood, g.user_reaction, g.is_friend,
      0::numeric AS final_score,
      'fallback_v7_empty_candidates'::text AS rank_reason,
      COALESCE(v_assignment.variant, 'a')::text AS experiment_variant
    FROM public.get_feed_posts(v_user_id, v_limit, v_offset) g;
    RETURN;
  END IF;

  RETURN QUERY
  WITH friends AS (
    SELECT CASE WHEN requester_id = v_user_id THEN addressee_id ELSE requester_id END AS friend_id
    FROM public.friendships
    WHERE v_user_id IS NOT NULL
      AND status = 'accepted'
      AND (requester_id = v_user_id OR addressee_id = v_user_id)
  ),
  candidates AS (
    SELECT *
    FROM public.ml_retrieve_feed_candidates_v8(v_user_id, 500)
  ),
  score_batch AS (
    SELECT *
    FROM public.feed_score_batch(v_user_id, v_candidate_ids, 'smart')
  ),
  recent_author AS (
    SELECT p.user_id AS author_id, COUNT(*)::numeric AS seen_count
    FROM public.ml_interactions mi
    JOIN public.posts p ON p.id = mi.post_id
    WHERE mi.user_id = v_user_id
      AND mi.created_at > now() - interval '36 hours'
      AND mi.signal_type IN ('view', 'dwell_medium', 'dwell_long', 'watch_complete', 'skip_fast')
    GROUP BY p.user_id
  ),
  base AS (
    SELECT
      p.id,
      p.user_id,
      p.body,
      p.image_url,
      p.created_at,
      p.expires_at,
      COALESCE(p.likes_count, 0) AS likes_count,
      COALESCE(p.comments_count, 0) AS comments_count,
      pr.name AS author_name,
      pr.avatar_url AS author_avatar,
      pr.mood_emoji AS author_mood,
      l.reaction_type AS user_reaction,
      EXISTS (SELECT 1 FROM friends f WHERE f.friend_id = p.user_id) AS is_friend,
      c.retrieval_source,
      c.retrieval_score,
      COALESCE(s.final_score, 50)::numeric AS v7_score,
      COALESCE(f.content_sensitivity_score, 0)::numeric AS sensitivity,
      COALESCE(f.repetitive_score, 0)::numeric AS repetitive,
      COALESCE(f.novelty_score, 0.5)::numeric AS novelty,
      COALESCE(cf.quality_score, 0.5)::numeric AS creator_quality,
      COALESCE(cf.fatigue_score, 0)::numeric AS creator_fatigue,
      COALESCE(ra.seen_count, 0)::numeric AS recent_author_seen,
      (get_byte(decode(substr(md5(COALESCE(v_user_id::text, 'guest') || ':' || p.id::text || ':' || date_trunc('day', now())::text), 1, 2), 'hex'), 0)::numeric / 255.0) AS stable_explore
    FROM candidates c
    JOIN public.posts p ON p.id = c.post_id
    JOIN public.profiles pr ON pr.user_id = p.user_id
    LEFT JOIN score_batch s ON s.post_id = p.id
    LEFT JOIN public.ml_post_features f ON f.post_id = p.id
    LEFT JOIN public.ml_creator_features cf ON cf.creator_id = p.user_id
    LEFT JOIN recent_author ra ON ra.author_id = p.user_id
    LEFT JOIN public.likes l ON l.post_id = p.id AND l.user_id = v_user_id
    WHERE (p.expires_at IS NULL OR p.expires_at > now())
  ),
  scored AS (
    SELECT
      b.*,
      ROW_NUMBER() OVER (
        PARTITION BY b.user_id
        ORDER BY b.v7_score DESC, b.retrieval_score DESC, b.created_at DESC
      ) AS author_rank,
      LEAST(100, GREATEST(0,
        b.v7_score * GREATEST(0.30, 1.0 - COALESCE(v_assignment.retrieval_weight, 0.24) - COALESCE(v_assignment.exploration_weight, 0.04))
        + (b.retrieval_score * 100.0) * COALESCE(v_assignment.retrieval_weight, 0.24)
        + (b.stable_explore * 100.0) * COALESCE(v_assignment.exploration_weight, 0.04)
        + b.novelty * 8.0
        + b.creator_quality * 5.0
        + CASE WHEN b.recent_author_seen = 0 THEN COALESCE(v_assignment.new_creator_boost, 0.05) * 100.0 ELSE 0 END
        - LEAST(22.0, b.recent_author_seen * 6.0)
        - b.creator_fatigue * 16.0
        - b.repetitive * 18.0
        - b.sensitivity * 24.0
      ))::numeric AS final_score
    FROM base b
  ),
  filtered AS (
    SELECT *
    FROM scored
    WHERE author_rank <= COALESCE(v_assignment.diversity_author_cap, 2)
       OR user_id = v_user_id
  )
  SELECT
    f.id,
    f.user_id,
    f.body,
    f.image_url,
    f.created_at,
    f.expires_at,
    f.likes_count,
    f.comments_count,
    f.author_name,
    f.author_avatar,
    f.author_mood,
    f.user_reaction,
    f.is_friend,
    f.final_score,
    CASE
      WHEN f.sensitivity > 0.5 THEN 'safety_dampened'
      WHEN f.repetitive > 0.45 THEN 'anti_loop'
      WHEN f.retrieval_source IN ('semantic_768', 'two_tower_256') THEN 'embedding_match'
      WHEN f.retrieval_source = 'interest' THEN 'interest_match'
      WHEN f.retrieval_source = 'social' THEN 'social_affinity'
      WHEN f.recent_author_seen = 0 THEN 'new_creator_explore'
      ELSE 'recsys_v8'
    END AS rank_reason,
    COALESCE(v_assignment.variant, 'a')::text AS experiment_variant
  FROM filtered f
  ORDER BY f.final_score DESC, f.created_at DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_feed_posts_v8(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_feed_posts_v8(uuid, integer, integer) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.ml_record_feed_ab_events(p_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_assignment record;
  v_count integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN 0;
  END IF;

  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN 0;
  END IF;

  SELECT *
  INTO v_assignment
  FROM public.ml_recsys_v8_assignment(v_user_id, 'recsys_v8_main')
  LIMIT 1;

  WITH raw AS (
    SELECT value AS e, ord
    FROM jsonb_array_elements(p_events) WITH ORDINALITY
    WHERE ord <= 100
  ),
  clean AS (
    SELECT
      CASE
        WHEN (e->>'post_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (e->>'post_id')::uuid
        ELSE NULL::uuid
      END AS post_id,
      COALESCE(NULLIF(e->>'event_type', ''), 'view') AS event_type,
      COALESCE(NULLIF(e->>'surface', ''), 'feed') AS surface,
      CASE
        WHEN (e->>'dwell_ms') ~ '^[0-9]+$'
          THEN LEAST(86400000, GREATEST(0, (e->>'dwell_ms')::integer))
        ELSE NULL::integer
      END AS dwell_ms,
      CASE
        WHEN (e->>'weight') ~ '^-?[0-9]+(\.[0-9]+)?$'
          THEN GREATEST(-9.99, LEAST(9.99, (e->>'weight')::numeric))
        ELSE 1::numeric
      END AS weight,
      COALESCE(e->'metadata', '{}'::jsonb) AS metadata
    FROM raw
    WHERE jsonb_typeof(e) = 'object'
  ),
  inserted AS (
    INSERT INTO public.ml_feed_experiment_events (
      user_id,
      experiment_key,
      variant,
      post_id,
      event_type,
      surface,
      dwell_ms,
      weight,
      metadata
    )
    SELECT
      v_user_id,
      COALESCE(v_assignment.experiment_key, 'recsys_v8_main'),
      COALESCE(v_assignment.variant, 'a'),
      c.post_id,
      c.event_type,
      c.surface,
      c.dwell_ms,
      c.weight,
      c.metadata
    FROM clean c
    WHERE c.post_id IS NOT NULL
      AND c.event_type IN (
        'view', 'impression', 'click', 'dwell_medium', 'dwell_long',
        'watch_complete', 'like', 'comment', 'share', 'save',
        'skip_fast', 'not_interested', 'hide', 'report'
      )
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  RETURN COALESCE(v_count, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.ml_record_feed_ab_events(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ml_record_feed_ab_events(jsonb) TO authenticated;

CREATE OR REPLACE VIEW public.ml_training_labels_v8
WITH (security_invoker = true) AS
SELECT
  mi.user_id,
  mi.post_id,
  MAX(CASE WHEN mi.signal_type = 'watch_complete' THEN 1 ELSE 0 END)::integer AS label_watch_complete,
  MAX(CASE WHEN mi.signal_type IN ('like', 'save', 'share', 'comment') THEN 1 ELSE 0 END)::integer AS label_positive_action,
  MAX(CASE WHEN mi.signal_type IN ('hide', 'not_interested', 'report', 'skip_fast') THEN 1 ELSE 0 END)::integer AS label_negative_action,
  AVG(COALESCE(mi.dwell_ms, 0))::numeric AS avg_dwell_ms,
  COUNT(*)::integer AS sample_count,
  MAX(mi.created_at) AS last_signal_at
FROM public.ml_interactions mi
GROUP BY mi.user_id, mi.post_id;

REVOKE ALL ON public.ml_training_labels_v8 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ml_training_labels_v8 TO authenticated;
