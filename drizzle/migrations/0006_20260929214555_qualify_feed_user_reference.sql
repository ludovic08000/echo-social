-- Fix PL/pgSQL ambiguity between the function output column `user_id`
-- and the `scored` CTE column. Ranking formulas and experiment weights
-- are intentionally unchanged.
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
    FROM scored AS scored_post
    WHERE scored_post.author_rank <= COALESCE(v_assignment.diversity_author_cap, 2)
       OR scored_post.user_id = v_user_id
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