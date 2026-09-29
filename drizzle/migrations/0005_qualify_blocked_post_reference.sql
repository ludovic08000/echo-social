-- Fix PL/pgSQL ambiguity between the function output column `post_id`
-- and the `blocked` CTE column. Ranking formulas and experiment weights
-- are intentionally unchanged.
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
      AND (v_user_id IS NULL OR p.id NOT IN (
        SELECT blocked_post.post_id FROM blocked AS blocked_post
      ))
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
      AND p.id NOT IN (
        SELECT blocked_post.post_id FROM blocked AS blocked_post
      )
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
      AND p.id NOT IN (
        SELECT blocked_post.post_id FROM blocked AS blocked_post
      )
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
      AND p.id NOT IN (
        SELECT blocked_post.post_id FROM blocked AS blocked_post
      )
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
      AND p.id NOT IN (
        SELECT blocked_post.post_id FROM blocked AS blocked_post
      )
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
      AND (v_user_id IS NULL OR p.id NOT IN (
        SELECT blocked_post.post_id FROM blocked AS blocked_post
      ))
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