-- Vectorize the two remaining feed hot paths.
--
-- The previous implementations repeatedly loaded the same user context and
-- rescanned interaction history for every candidate. Keep the retrieval and
-- scoring formulas unchanged, but load request-scoped state once and aggregate
-- interaction signals in one pass. The scorer retains the original row-wise
-- implementation as an exception fallback for unexpected legacy data.

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
  v_blocked_ids uuid[] := ARRAY[]::uuid[];
  v_friend_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_user_id IS NOT NULL THEN
    SELECT profile.embedding
    INTO v_user_emb_768
    FROM public.ml_user_profiles AS profile
    WHERE profile.user_id = v_user_id;

    SELECT embedding.embedding
    INTO v_user_emb_256
    FROM public.ml_user_embeddings AS embedding
    WHERE embedding.user_id = v_user_id;

    SELECT COALESCE(array_agg(lower(ranked_interest.interest_value)), ARRAY[]::text[])
    INTO v_interests
    FROM (
      SELECT interest.interest_value
      FROM public.user_interests AS interest
      WHERE interest.user_id = v_user_id
      ORDER BY interest.weight DESC NULLS LAST
      LIMIT 80
    ) AS ranked_interest;

    SELECT COALESCE(array_agg(interaction.post_id), ARRAY[]::uuid[])
    INTO v_blocked_ids
    FROM public.ml_interactions AS interaction
    WHERE interaction.user_id = v_user_id
      AND interaction.created_at > now() - interval '90 days'
      AND interaction.signal_type IN ('hide', 'not_interested', 'report');

    SELECT COALESCE(
      array_agg(
        CASE
          WHEN friendship.requester_id = v_user_id THEN friendship.addressee_id
          ELSE friendship.requester_id
        END
      ),
      ARRAY[]::uuid[]
    )
    INTO v_friend_ids
    FROM public.friendships AS friendship
    WHERE friendship.status = 'accepted'
      AND (
        friendship.requester_id = v_user_id
        OR friendship.addressee_id = v_user_id
      );
  ELSE
    v_interests := ARRAY[]::text[];
  END IF;

  RETURN QUERY
  WITH recent AS (
    SELECT
      post.id AS post_id,
      'recent'::text AS retrieval_source,
      LEAST(
        1.0,
        POWER(
          0.5,
          GREATEST(0.05, EXTRACT(EPOCH FROM (now() - post.created_at)) / 3600.0) / 18.0
        )
      )::numeric AS retrieval_score,
      1 AS source_priority
    FROM public.posts AS post
    WHERE (post.expires_at IS NULL OR post.expires_at > now())
      AND post.created_at > now() - interval '60 days'
      AND NOT (post.id = ANY(v_blocked_ids))
    ORDER BY post.created_at DESC
    LIMIT 220
  ),
  social AS (
    SELECT
      post.id AS post_id,
      'social'::text AS retrieval_source,
      (
        0.72
        + LEAST(
          0.24,
          LN(1 + COALESCE(post.likes_count, 0) + COALESCE(post.comments_count, 0) * 2) / 18.0
        )
      )::numeric AS retrieval_score,
      2 AS source_priority
    FROM public.posts AS post
    WHERE v_user_id IS NOT NULL
      AND post.user_id = ANY(v_friend_ids)
      AND (post.expires_at IS NULL OR post.expires_at > now())
      AND post.created_at > now() - interval '90 days'
      AND NOT (post.id = ANY(v_blocked_ids))
    ORDER BY post.created_at DESC
    LIMIT 160
  ),
  interest AS (
    SELECT
      post.id AS post_id,
      'interest'::text AS retrieval_source,
      LEAST(1.0, 0.58 + COUNT(*)::numeric * 0.10)::numeric AS retrieval_score,
      3 AS source_priority
    FROM public.posts AS post
    LEFT JOIN public.ml_post_features AS feature ON feature.post_id = post.id
    WHERE v_user_id IS NOT NULL
      AND COALESCE(array_length(v_interests, 1), 0) > 0
      AND (post.expires_at IS NULL OR post.expires_at > now())
      AND post.created_at > now() - interval '120 days'
      AND NOT (post.id = ANY(v_blocked_ids))
      AND (
        EXISTS (
          SELECT 1
          FROM unnest(v_interests) AS user_interest(value)
          WHERE position(user_interest.value IN lower(COALESCE(post.body, ''))) > 0
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(feature.hashtags, ARRAY[]::text[])) AS hashtag(value)
          WHERE lower(hashtag.value) = ANY(v_interests)
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(feature.topics, ARRAY[]::text[])) AS topic(value)
          WHERE lower(topic.value) = ANY(v_interests)
        )
      )
    GROUP BY post.id
    ORDER BY retrieval_score DESC, post.created_at DESC
    LIMIT 180
  ),
  semantic_768 AS (
    SELECT
      feature.post_id,
      'semantic_768'::text AS retrieval_source,
      GREATEST(
        0.0,
        LEAST(1.0, ((1 - (feature.embedding <=> v_user_emb_768)) + 1.0) / 2.0)
      )::numeric AS retrieval_score,
      4 AS source_priority
    FROM public.ml_post_features AS feature
    JOIN public.posts AS post ON post.id = feature.post_id
    WHERE v_user_emb_768 IS NOT NULL
      AND feature.embedding IS NOT NULL
      AND (post.expires_at IS NULL OR post.expires_at > now())
      AND NOT (post.id = ANY(v_blocked_ids))
    ORDER BY feature.embedding <=> v_user_emb_768
    LIMIT 220
  ),
  two_tower_256 AS (
    SELECT
      embedding.post_id,
      'two_tower_256'::text AS retrieval_source,
      GREATEST(
        0.0,
        LEAST(1.0, ((1 - (embedding.embedding <=> v_user_emb_256)) + 1.0) / 2.0)
      )::numeric AS retrieval_score,
      5 AS source_priority
    FROM public.ml_post_embeddings AS embedding
    JOIN public.posts AS post ON post.id = embedding.post_id
    WHERE v_user_emb_256 IS NOT NULL
      AND embedding.embedding IS NOT NULL
      AND (post.expires_at IS NULL OR post.expires_at > now())
      AND NOT (post.id = ANY(v_blocked_ids))
    ORDER BY embedding.embedding <=> v_user_emb_256
    LIMIT 220
  ),
  cold_start AS (
    SELECT
      post.id AS post_id,
      'cold_start'::text AS retrieval_source,
      0.54::numeric AS retrieval_score,
      6 AS source_priority
    FROM public.posts AS post
    LEFT JOIN public.ml_post_features AS feature ON feature.post_id = post.id
    WHERE (post.expires_at IS NULL OR post.expires_at > now())
      AND post.created_at > now() - interval '24 hours'
      AND (
        COALESCE(post.likes_count, 0)
        + COALESCE(post.comments_count, 0)
        + COALESCE(feature.watch_sample_count, 0)
      ) < 12
      AND NOT (post.id = ANY(v_blocked_ids))
    ORDER BY post.created_at DESC
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
    SELECT DISTINCT ON (candidate.post_id)
      candidate.post_id,
      candidate.retrieval_source,
      candidate.retrieval_score
    FROM unioned AS candidate
    ORDER BY
      candidate.post_id,
      candidate.retrieval_score DESC,
      candidate.source_priority
  )
  SELECT
    reduced_candidate.post_id,
    reduced_candidate.retrieval_source,
    reduced_candidate.retrieval_score
  FROM reduced AS reduced_candidate
  ORDER BY reduced_candidate.retrieval_score DESC
  LIMIT v_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ml_pareto_score_batch(
  p_user_id uuid,
  p_post_ids uuid[]
)
RETURNS TABLE (
  post_id uuid,
  score numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_profile public.ml_user_profiles%ROWTYPE;
  v_user_emb_256 vector(256);
  v_weights jsonb;
  v_wellbeing_score integer;
  v_hour text := EXTRACT(HOUR FROM now())::text;
  v_paris_hour integer := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::integer;
  v_post_id uuid;
  v_score numeric;
BEGIN
  IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF array_length(p_post_ids, 1) > 200 THEN
    RAISE EXCEPTION 'Batch size exceeds limit (200)';
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.ml_user_profiles AS profile
  WHERE profile.user_id = v_user_id;

  SELECT embedding.embedding
  INTO v_user_emb_256
  FROM public.ml_user_embeddings AS embedding
  WHERE embedding.user_id = v_user_id;

  SELECT config.value
  INTO v_weights
  FROM public.ml_model_config AS config
  WHERE config.key = 'hybrid_weights';

  SELECT wellbeing.score
  INTO v_wellbeing_score
  FROM public.wellbeing_scores AS wellbeing
  WHERE wellbeing.user_id = v_user_id;

  BEGIN
    RETURN QUERY
    WITH input_posts AS MATERIALIZED (
      SELECT input.post_id, input.ordinality
      FROM unnest(p_post_ids) WITH ORDINALITY AS input(post_id, ordinality)
    ),
    interaction_rollup AS MATERIALIZED (
      SELECT
        interaction.post_id,
        COUNT(*) FILTER (
          WHERE interaction.created_at > now() - interval '1 hour'
            AND interaction.signal_type IN (
              'like', 'comment', 'share', 'dwell_long', 'watch_complete'
            )
        )::numeric AS velocity_count,
        COUNT(*) FILTER (
          WHERE interaction.signal_type IN ('hide', 'skip_fast', 'report', 'dislike')
        )::numeric AS negative_count
      FROM public.ml_interactions AS interaction
      WHERE interaction.post_id = ANY(p_post_ids)
        AND interaction.created_at > now() - interval '24 hours'
      GROUP BY interaction.post_id
    ),
    raw_components AS (
      SELECT
        input.ordinality,
        input.post_id,
        CASE
          WHEN feature.post_id IS NULL THEN 0.5::numeric
          WHEN v_profile.user_id IS NULL THEN (
            0.5 * COALESCE((v_weights->>'collaborative')::numeric, 0.4)
            + 0.5 * COALESCE((v_weights->>'content')::numeric, 0.4)
            + 0.5 * COALESCE((v_weights->>'temporal')::numeric, 0.1)
            + (
              COALESCE(feature.quality_score, 0.5)
              + LEAST(1.0, COALESCE(feature.ctr, 0) * 10)
            ) / 2.0 * COALESCE((v_weights->>'quality')::numeric, 0.1)
          )::numeric
          ELSE (
            LEAST(
              1.0,
              GREATEST(
                0.0,
                (
                  COALESCE((
                    SELECT SUM(
                      COALESCE((v_profile.topic_weights->>topic.value)::numeric, 0)
                    )
                    FROM unnest(feature.topics) AS topic(value)
                  ), 0)
                  + COALESCE((
                    SELECT SUM(
                      COALESCE((v_profile.hashtag_weights->>hashtag.value)::numeric, 0) * 0.5
                    )
                    FROM unnest(feature.hashtags) AS hashtag(value)
                  ), 0)
                ) / 5.0
              )
            ) * COALESCE((v_weights->>'content')::numeric, 0.4)
            + LEAST(
              1.0,
              GREATEST(
                0.0,
                COALESCE((v_profile.author_affinity->>post.user_id::text)::numeric, 0)
              )
            ) * COALESCE((v_weights->>'collaborative')::numeric, 0.4)
            + LEAST(
              1.0,
              GREATEST(
                0.0,
                COALESCE((v_profile.hourly_activity->>v_hour)::numeric, 0.5)
              )
            ) * COALESCE((v_weights->>'temporal')::numeric, 0.1)
            + (
              COALESCE(feature.quality_score, 0.5)
              + LEAST(1.0, COALESCE(feature.ctr, 0) * 10)
            ) / 2.0 * COALESCE((v_weights->>'quality')::numeric, 0.1)
          )::numeric
        END AS classic_v1,
        CASE
          WHEN v_profile.embedding IS NOT NULL AND feature.embedding IS NOT NULL THEN
            GREATEST(
              0.0,
              LEAST(
                1.0,
                (((1 - (v_profile.embedding <=> feature.embedding)) + 1) / 2.0)::numeric
              )
            )
          ELSE 0.5::numeric
        END AS semantic_score,
        CASE
          WHEN COALESCE(feature.avg_watch_time_ms, 0) > 0
            AND COALESCE(v_profile.avg_dwell_ms, 0) > 0
          THEN (
            LEAST(
              1.0,
              feature.avg_watch_time_ms / GREATEST(v_profile.avg_dwell_ms, 1000)
            ) - 0.5
          ) * 0.2
          ELSE 0::numeric
        END AS watch_bonus,
        CASE
          WHEN v_user_emb_256 IS NOT NULL AND post_embedding.embedding IS NOT NULL THEN
            GREATEST(
              0.0,
              LEAST(1.0, (1 - (v_user_emb_256 <=> post_embedding.embedding))::numeric)
            )
          ELSE NULL::numeric
        END AS neural_score,
        COALESCE(
          feature.wellbeing_score,
          GREATEST(0.0, LEAST(1.0, (feature.sentiment + 1) / 2.0))
        )::numeric AS positivity,
        LEAST(1.0, COALESCE(rollup.velocity_count, 0) / 25.0)::numeric AS velocity_norm,
        LEAST(1.0, COALESCE(rollup.negative_count, 0) / 10.0)::numeric AS negative_signal
      FROM input_posts AS input
      LEFT JOIN public.posts AS post ON post.id = input.post_id
      LEFT JOIN public.ml_post_features AS feature ON feature.post_id = input.post_id
      LEFT JOIN public.ml_post_embeddings AS post_embedding
        ON post_embedding.post_id = input.post_id
      LEFT JOIN interaction_rollup AS rollup ON rollup.post_id = input.post_id
    ),
    classic_scores AS (
      SELECT
        component.*,
        LEAST(
          1.0,
          GREATEST(
            0.0,
            component.classic_v1 * 0.5 + component.semantic_score * 0.5
          )
        )::numeric AS classic_v2
      FROM raw_components AS component
    ),
    full_components AS (
      SELECT
        classic.*,
        LEAST(
          1.0,
          GREATEST(0.0, classic.classic_v2 + classic.watch_bonus)
        )::numeric AS classic_v3,
        CASE
          WHEN v_wellbeing_score < 50 THEN (classic.positivity - 0.5) * 0.20
          ELSE (classic.positivity - 0.5) * 0.08
        END::numeric AS wellbeing_bonus,
        CASE
          WHEN v_paris_hour >= 0 AND v_paris_hour < 6 THEN
            classic.velocity_norm * 0.10 + (1 - classic.positivity) * 0.05
          ELSE 0::numeric
        END AS late_penalty
      FROM classic_scores AS classic
    )
    SELECT
      component.post_id,
      GREATEST(
        0.0,
        LEAST(
          1.0,
          CASE
            WHEN component.neural_score IS NOT NULL THEN
              component.neural_score * 0.50
              + component.classic_v3 * 0.35
              + component.velocity_norm * 0.10
              + component.positivity * 0.05
            ELSE
              component.classic_v3 * 0.70
              + component.velocity_norm * 0.20
              + component.positivity * 0.10
          END
          + component.wellbeing_bonus
          - component.late_penalty
          - component.negative_signal * 0.30
        )
      )::numeric AS score
    FROM full_components AS component
    ORDER BY component.ordinality;
  EXCEPTION WHEN OTHERS THEN
    FOREACH v_post_id IN ARRAY p_post_ids LOOP
      BEGIN
        v_score := public.ml_score_post_v5(v_user_id, v_post_id);
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          v_score := public.ml_score_post_v4(v_user_id, v_post_id);
        EXCEPTION WHEN OTHERS THEN
          v_score := 0.5;
        END;
      END;

      post_id := v_post_id;
      score := COALESCE(v_score, 0.5);
      RETURN NEXT;
    END LOOP;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.ml_retrieve_feed_candidates_v8(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ml_retrieve_feed_candidates_v8(uuid, integer) TO authenticated, anon;

REVOKE ALL ON FUNCTION public.ml_pareto_score_batch(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ml_pareto_score_batch(uuid, uuid[]) TO authenticated;
