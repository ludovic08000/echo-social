ALTER TABLE public.quality_events ADD COLUMN client_event_id uuid UNIQUE;
ALTER TABLE public.feed_rank_snapshots ADD COLUMN experiment_revision text;

CREATE TABLE public.feed_served_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES public.feed_rank_snapshots(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  variant text NOT NULL CHECK (variant IN ('a','b')),
  experiment_revision text,
  served_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, post_id)
);
ALTER TABLE public.feed_served_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feed_served_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.feed_served_items TO service_role;
CREATE INDEX feed_served_viewer_time ON public.feed_served_items(viewer_id, served_at DESC);

CREATE OR REPLACE FUNCTION public.finalize_feed_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  remaining jsonb := NEW.items;
  result jsonb := '[]'::jsonb;
  recent_authors text[] := ARRAY[]::text[];
  candidate jsonb;
  selected_index integer;
  feed_mode text;
  author_cap integer := 2;
BEGIN
  SELECT md5(e.variant_a::text || e.variant_b::text || e.traffic_split::text || e.updated_at::text)
    INTO NEW.experiment_revision FROM public.ml_feed_experiments e WHERE e.key = 'recsys_v8_main';
  SELECT preference.feed_algorithm INTO feed_mode
    FROM public.user_feed_preferences preference WHERE preference.user_id = NEW.viewer_id;
  IF COALESCE(feed_mode, 'smart') <> 'smart' THEN RETURN NEW; END IF;
  SELECT COALESCE(a.diversity_author_cap, 2) INTO author_cap
    FROM public.ml_recsys_v8_assignment(NEW.viewer_id, 'recsys_v8_main') a;
  WHILE jsonb_array_length(remaining) > 0 LOOP
    SELECT (entry.ordinality - 1)::integer, entry.value INTO selected_index, candidate
    FROM jsonb_array_elements(remaining) WITH ORDINALITY entry(value, ordinality)
    WHERE (SELECT count(*) FROM unnest(recent_authors) author_id
      WHERE author_id = entry.value->>'user_id') < author_cap
    ORDER BY entry.ordinality LIMIT 1;
    IF selected_index IS NULL THEN selected_index := 0; candidate := remaining->0; END IF;
    result := result || jsonb_build_array(candidate);
    recent_authors := array_append(recent_authors, candidate->>'user_id');
    IF cardinality(recent_authors) > 11 THEN recent_authors := recent_authors[2:12]; END IF;
    remaining := remaining - selected_index;
  END LOOP;
  NEW.items := result;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.finalize_feed_snapshot() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER z_finalize_feed_snapshot BEFORE INSERT ON public.feed_rank_snapshots
FOR EACH ROW EXECUTE FUNCTION public.finalize_feed_snapshot();

CREATE OR REPLACE FUNCTION public.feed_eligible_post_ids_internal(
  p_viewer_id uuid,
  p_post_ids uuid[]
)
RETURNS TABLE (post_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT post.id
  FROM public.posts AS post
  JOIN public.profiles AS profile
    ON profile.user_id = post.user_id
  LEFT JOIN public.privacy_settings AS privacy
    ON privacy.user_id = post.user_id
  LEFT JOIN public.user_feed_preferences AS preference
    ON preference.user_id = p_viewer_id
  LEFT JOIN public.ml_post_features AS feature
    ON feature.post_id = post.id
  LEFT JOIN public.parental_controls AS viewer_parental
    ON viewer_parental.user_id = p_viewer_id
   AND viewer_parental.is_active = true
   AND viewer_parental.is_minor = true
  WHERE p_post_ids IS NOT NULL
      AND post.id = ANY(p_post_ids)
      AND (post.publish_at IS NULL OR post.publish_at <= now())
      AND (post.expires_at IS NULL OR post.expires_at > now())
      AND (
        post.user_id = p_viewer_id
        OR COALESCE(privacy.profile_visibility, 'public') = 'public'
        OR (privacy.profile_visibility = 'friends' AND EXISTS (
          SELECT 1 FROM public.friendships f WHERE f.status = 'accepted'
          AND ((f.requester_id = p_viewer_id AND f.addressee_id = post.user_id)
            OR (f.addressee_id = p_viewer_id AND f.requester_id = post.user_id))
        ))
      )
      AND (
        post.user_id = p_viewer_id
        OR COALESCE(privacy.posts_visibility, 'public') = 'public'
        OR (
          COALESCE(privacy.posts_visibility, 'public') = 'friends'
          AND p_viewer_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.friendships AS friendship
            WHERE friendship.status = 'accepted'
              AND (
                (friendship.requester_id = p_viewer_id AND friendship.addressee_id = post.user_id)
                OR
                (friendship.addressee_id = p_viewer_id AND friendship.requester_id = post.user_id)
              )
          )
        )
      )
      AND (
        p_viewer_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.user_message_blocks AS user_block
          WHERE
            (user_block.blocker_user_id = p_viewer_id AND user_block.blocked_user_id = post.user_id)
            OR
            (user_block.blocker_user_id = post.user_id AND user_block.blocked_user_id = p_viewer_id)
        )
      )
      AND (
        p_viewer_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.ml_interactions AS exclusion
          WHERE exclusion.user_id = p_viewer_id
            AND exclusion.post_id = post.id
            AND exclusion.signal_type IN ('hide', 'not_interested', 'report')
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(COALESCE(preference.muted_keywords, ARRAY[]::text[])) AS muted(keyword)
        WHERE muted.keyword <> ''
          AND strpos(lower(COALESCE(post.body, '')), lower(muted.keyword)) > 0
      )
      AND (
        NOT COALESCE(preference.sensitive_content_filter, true)
        OR COALESCE(feature.content_sensitivity_score, 0) <= 0.5
      )
      AND (
        viewer_parental.user_id IS NULL
        OR (
          COALESCE(feature.content_sensitivity_score, 0) <= 0.35
          AND public.parental_content_category_allowed(
            post.body,
            feature.topics,
            feature.hashtags,
            viewer_parental.allowed_categories
          )
        )
      )
      AND (
        NOT COALESCE(preference.seen_posts_hide, false)
        OR p_viewer_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.ml_interactions AS seen
          WHERE seen.user_id = p_viewer_id
            AND seen.post_id = post.id
            AND seen.signal_type IN ('view', 'dwell_medium', 'dwell_long', 'watch_complete')
        )
      );
$function$;

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
SET search_path = ''
AS $function$
DECLARE
  v_authenticated_user uuid := (SELECT auth.uid());
  v_claim_role text := COALESCE((SELECT auth.jwt() ->> 'role'), 'anon');
  v_user_id uuid;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 25), 200));
  v_offset integer := GREATEST(0, COALESCE(p_offset, 0));
  v_candidate_ids uuid[];
  v_candidate_sources text[];
  v_candidate_scores numeric[];
  v_scoring_ids uuid[];
  v_assignment record;
BEGIN
  IF v_authenticated_user IS NOT NULL THEN
    IF p_user_id IS NOT NULL AND p_user_id <> v_authenticated_user THEN
      RAISE EXCEPTION 'feed viewer does not match authenticated user'
        USING ERRCODE = '42501';
    END IF;
    v_user_id := v_authenticated_user;
  ELSIF v_claim_role = 'service_role' THEN
    v_user_id := p_user_id;
  ELSE
    v_user_id := NULL;
  END IF;

  SELECT *
  INTO v_assignment
  FROM public.ml_recsys_v8_assignment(v_user_id, 'recsys_v8_main')
  LIMIT 1;

  WITH candidate_pool AS MATERIALIZED (
    SELECT
      candidate.post_id,
      candidate.retrieval_source,
      candidate.retrieval_score
    FROM public.ml_retrieve_feed_candidates_v8(v_user_id, 500) AS candidate
  ),
  eligible AS MATERIALIZED (
    SELECT eligible_post.post_id
    FROM public.feed_eligible_post_ids_internal(
      v_user_id,
      ARRAY(
        SELECT candidate_post.post_id
        FROM candidate_pool AS candidate_post
      )
    ) AS eligible_post
  )
  SELECT
    array_agg(candidate.post_id ORDER BY candidate.retrieval_score DESC, candidate.post_id),
    array_agg(candidate.retrieval_source ORDER BY candidate.retrieval_score DESC, candidate.post_id),
    array_agg(candidate.retrieval_score ORDER BY candidate.retrieval_score DESC, candidate.post_id)
  INTO v_candidate_ids, v_candidate_sources, v_candidate_scores
  FROM candidate_pool AS candidate
  JOIN eligible AS eligible_post
    ON eligible_post.post_id = candidate.post_id;

  IF v_candidate_ids IS NULL OR cardinality(v_candidate_ids) = 0 THEN
    RETURN QUERY
    SELECT
      guest.id, guest.user_id, guest.body, guest.image_url,
      guest.created_at, guest.expires_at, guest.likes_count,
      guest.comments_count, guest.author_name, guest.author_avatar,
      guest.author_mood, guest.user_reaction, guest.is_friend,
      0::numeric AS final_score,
      'fallback_v7_empty_candidates'::text AS rank_reason,
      COALESCE(v_assignment.variant, 'a')::text AS experiment_variant
    FROM public.get_feed_posts(v_user_id, v_limit, v_offset) AS guest
    WHERE public.feed_post_is_eligible_internal(v_user_id, guest.id)
    ORDER BY guest.created_at DESC, guest.id;
    RETURN;
  END IF;

  v_scoring_ids := v_candidate_ids;

  RETURN QUERY
  WITH friends AS (
    SELECT
      CASE
        WHEN friendship.requester_id = v_user_id THEN friendship.addressee_id
        ELSE friendship.requester_id
      END AS friend_id
    FROM public.friendships AS friendship
    WHERE v_user_id IS NOT NULL
      AND friendship.status = 'accepted'
      AND (
        friendship.requester_id = v_user_id
        OR friendship.addressee_id = v_user_id
      )
  ),
  candidates AS MATERIALIZED (
    SELECT
      candidate.post_id,
      candidate.retrieval_source,
      candidate.retrieval_score
    FROM unnest(v_candidate_ids, v_candidate_sources, v_candidate_scores)
      AS candidate(post_id, retrieval_source, retrieval_score)
  ),
  score_batch AS MATERIALIZED (
    SELECT score.*
    FROM generate_series(1, cardinality(v_scoring_ids), 200) AS chunk(first_index)
    CROSS JOIN LATERAL public.feed_score_batch(
      v_user_id, v_scoring_ids[chunk.first_index:chunk.first_index + 199], 'smart'
    ) AS score
  ),
  recent_author AS (
    SELECT post.user_id AS author_id, COUNT(*)::numeric AS seen_count
    FROM public.ml_interactions AS interaction
    JOIN public.posts AS post ON post.id = interaction.post_id
    WHERE interaction.user_id = v_user_id
      AND interaction.created_at > now() - interval '36 hours'
      AND interaction.signal_type IN (
        'view', 'dwell_medium', 'dwell_long',
        'watch_complete', 'skip_fast'
      )
    GROUP BY post.user_id
  ),
  base AS (
    SELECT
      post.id,
      post.user_id,
      post.body,
      post.image_url,
      post.created_at,
      post.expires_at,
      COALESCE(post.likes_count, 0) AS likes_count,
      COALESCE(post.comments_count, 0) AS comments_count,
      profile.name AS author_name,
      profile.avatar_url AS author_avatar,
      profile.mood_emoji AS author_mood,
      user_like.reaction_type::text AS user_reaction,
      EXISTS (SELECT 1 FROM friends AS friend WHERE friend.friend_id = post.user_id) AS is_friend,
      candidate.retrieval_source,
      candidate.retrieval_score,
      COALESCE(score.final_score, 50)::numeric AS v7_score,
      COALESCE(feature.content_sensitivity_score, 0)::numeric AS sensitivity,
      COALESCE(feature.repetitive_score, 0)::numeric AS repetitive,
      COALESCE(feature.novelty_score, 0.5)::numeric AS novelty,
      COALESCE(creator.quality_score, 0.5)::numeric AS creator_quality,
      COALESCE(creator.fatigue_score, 0)::numeric AS creator_fatigue,
      COALESCE(recent.seen_count, 0)::numeric AS recent_author_seen,
      (
        get_byte(
          decode(
            substr(
              md5(
                COALESCE(v_user_id::text, 'guest') || ':' || post.id::text || ':' ||
                date_trunc('day', now())::text
              ),
              1,
              2
            ),
            'hex'
          ),
          0
        )::numeric / 255.0
      ) AS stable_explore
    FROM candidates AS candidate
    JOIN public.posts AS post ON post.id = candidate.post_id
    JOIN public.profiles AS profile ON profile.user_id = post.user_id
    LEFT JOIN score_batch AS score ON score.post_id = post.id
    LEFT JOIN public.ml_post_features AS feature ON feature.post_id = post.id
    LEFT JOIN public.ml_creator_features AS creator ON creator.creator_id = post.user_id
    LEFT JOIN recent_author AS recent ON recent.author_id = post.user_id
    LEFT JOIN public.likes AS user_like
      ON user_like.post_id = post.id AND user_like.user_id = v_user_id
  ),
  scored AS (
    SELECT
      base_post.*,
      ROW_NUMBER() OVER (
        PARTITION BY base_post.user_id
        ORDER BY base_post.v7_score DESC, base_post.retrieval_score DESC,
          base_post.created_at DESC, base_post.id
      ) AS author_rank,
      LEAST(100, GREATEST(0,
        base_post.v7_score * GREATEST(
          0.30,
          1.0
            - COALESCE(v_assignment.retrieval_weight, 0.24)
            - COALESCE(v_assignment.exploration_weight, 0.04)
        )
        + (base_post.retrieval_score * 100.0) * COALESCE(v_assignment.retrieval_weight, 0.24)
        + (base_post.stable_explore * 100.0) * COALESCE(v_assignment.exploration_weight, 0.04)
        + base_post.novelty * 8.0
        + base_post.creator_quality * 5.0
        + CASE
            WHEN base_post.recent_author_seen = 0
            THEN COALESCE(v_assignment.new_creator_boost, 0.05) * 100.0
            ELSE 0
          END
        - LEAST(22.0, base_post.recent_author_seen * 6.0)
        - base_post.creator_fatigue * 16.0
        - base_post.repetitive * 18.0
        - base_post.sensitivity * 24.0
      ))::numeric AS final_score
    FROM base AS base_post
  ),
  filtered AS (
    SELECT *
    FROM scored AS scored_post
  )
  SELECT
    filtered_post.id,
    filtered_post.user_id,
    filtered_post.body,
    filtered_post.image_url,
    filtered_post.created_at,
    filtered_post.expires_at,
    filtered_post.likes_count,
    filtered_post.comments_count,
    filtered_post.author_name,
    filtered_post.author_avatar,
    filtered_post.author_mood,
    filtered_post.user_reaction,
    filtered_post.is_friend,
    filtered_post.final_score,
    CASE
      WHEN filtered_post.sensitivity > 0.5 THEN 'safety_dampened'
      WHEN filtered_post.repetitive > 0.45 THEN 'anti_loop'
      WHEN filtered_post.retrieval_source IN ('semantic_768', 'two_tower_256') THEN 'embedding_match'
      WHEN filtered_post.retrieval_source = 'interest' THEN 'interest_match'
      WHEN filtered_post.retrieval_source = 'social' THEN 'social_affinity'
      WHEN filtered_post.recent_author_seen = 0 THEN 'new_creator_explore'
      ELSE 'recsys_v8'
    END AS rank_reason,
    COALESCE(v_assignment.variant, 'a')::text AS experiment_variant
  FROM filtered AS filtered_post
  ORDER BY
    filtered_post.final_score DESC,
    filtered_post.created_at DESC,
    filtered_post.id
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

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
  v_bucket numeric := 0;
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
    v_bucket := (('x' || substr(md5(v_user_id::text || ':' || p_experiment_key), 1, 8))::bit(32)::bigint)::numeric
      / 4294967296.0 * 100.0;
  END IF;

  IF v_user_id IS NOT NULL AND v_bucket < v_exp.traffic_split THEN
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

CREATE OR REPLACE FUNCTION public.get_ranked_feed_page(
  p_limit integer DEFAULT 25,
  p_cursor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer_id uuid := (SELECT auth.uid());
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 25), 50));
  v_snapshot_id uuid;
  v_snapshot_items jsonb;
  v_snapshot_expires_at timestamptz;
  v_start_position integer := 0;
  v_last_position integer;
  v_page_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_cursor uuid;
BEGIN
  IF p_cursor IS NULL THEN
    SELECT COALESCE(
      jsonb_agg(to_jsonb(ranked_post) ORDER BY
        ranked_post.final_score DESC,
        ranked_post.created_at DESC,
        ranked_post.id
      ),
      '[]'::jsonb
    )
    INTO v_snapshot_items
    FROM public.get_feed_posts_v8(v_viewer_id, 200, 0) AS ranked_post;

    v_snapshot_expires_at := now() + interval '30 minutes';

    INSERT INTO public.feed_rank_snapshots (
      viewer_id,
      items,
      expires_at
    )
    VALUES (
      v_viewer_id,
      v_snapshot_items,
      v_snapshot_expires_at
    )
    RETURNING id, items INTO v_snapshot_id, v_snapshot_items;

    IF pg_catalog.random() < 0.01 THEN
      DELETE FROM public.feed_rank_snapshots AS expired_snapshot
      WHERE expired_snapshot.id IN (
        SELECT stale_snapshot.id
        FROM public.feed_rank_snapshots AS stale_snapshot
        WHERE stale_snapshot.expires_at <= now()
        ORDER BY stale_snapshot.expires_at
        LIMIT 100
      );
    END IF;
  ELSE
    SELECT
      snapshot.id,
      snapshot.items,
      snapshot.expires_at,
      cursor_row.next_position
    INTO
      v_snapshot_id,
      v_snapshot_items,
      v_snapshot_expires_at,
      v_start_position
    FROM public.feed_rank_cursors AS cursor_row
    JOIN public.feed_rank_snapshots AS snapshot
      ON snapshot.id = cursor_row.snapshot_id
    WHERE cursor_row.token = p_cursor
      AND cursor_row.viewer_id IS NOT DISTINCT FROM v_viewer_id
      AND cursor_row.expires_at > now()
      AND snapshot.viewer_id IS NOT DISTINCT FROM v_viewer_id
      AND snapshot.expires_at > now();

    IF v_snapshot_id IS NULL THEN
      RAISE EXCEPTION 'feed cursor is invalid or expired'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  WITH expanded AS MATERIALIZED (
    SELECT
      entry.ordinality::integer AS position,
      entry.value
    FROM jsonb_array_elements(v_snapshot_items) WITH ORDINALITY
      AS entry(value, ordinality)
    WHERE entry.ordinality > v_start_position
  ),
  eligible AS MATERIALIZED (
    SELECT eligible_post.post_id
    FROM public.feed_eligible_post_ids_internal(
      v_viewer_id,
      ARRAY(
        SELECT (expanded_post.value ->> 'id')::uuid
        FROM expanded AS expanded_post
      )
    ) AS eligible_post
  ),
  visible AS MATERIALIZED (
    SELECT
      expanded.position,
      jsonb_build_object(
        'id', post.id,
        'user_id', post.user_id,
        'body', post.body,
        'image_url', post.image_url,
        'media_thumbnail_url', post.media_thumbnail_url,
        'created_at', post.created_at,
        'expires_at', post.expires_at,
        'likes_count', COALESCE(post.likes_count, 0),
        'comments_count', COALESCE(post.comments_count, 0),
        'author_name', profile.name,
        'author_avatar', profile.avatar_url,
        'author_mood', profile.mood_emoji,
        'user_reaction', user_like.reaction_type::text,
        'is_friend', EXISTS (
          SELECT 1
          FROM public.friendships AS friendship
          WHERE v_viewer_id IS NOT NULL
            AND friendship.status = 'accepted'
            AND (
              (friendship.requester_id = v_viewer_id AND friendship.addressee_id = post.user_id)
              OR
              (friendship.addressee_id = v_viewer_id AND friendship.requester_id = post.user_id)
            )
        ),
        'final_score', NULLIF(expanded.value ->> 'final_score', '')::numeric,
        'rank_reason', expanded.value ->> 'rank_reason',
        'experiment_variant', expanded.value ->> 'experiment_variant'
      ) AS item
    FROM expanded
    JOIN public.posts AS post
      ON post.id = (expanded.value ->> 'id')::uuid
    JOIN eligible AS eligible_post
      ON eligible_post.post_id = post.id
    JOIN public.profiles AS profile
      ON profile.user_id = post.user_id
    LEFT JOIN public.likes AS user_like
      ON user_like.post_id = post.id AND user_like.user_id = v_viewer_id
    ORDER BY expanded.position
  ),
  selected AS MATERIALIZED (
    SELECT visible_post.position, visible_post.item
    FROM visible AS visible_post
    ORDER BY visible_post.position
    LIMIT v_limit
  )
  SELECT
    COALESCE(jsonb_agg(selected.item ORDER BY selected.position), '[]'::jsonb),
    MAX(selected.position),
    (SELECT COUNT(*) FROM visible) > v_limit
  INTO v_page_items, v_last_position, v_has_more
  FROM selected;

  IF v_viewer_id IS NOT NULL THEN
    INSERT INTO public.feed_served_items(snapshot_id, viewer_id, post_id, variant, experiment_revision)
    SELECT v_snapshot_id, v_viewer_id, (item->>'id')::uuid,
      COALESCE(item->>'experiment_variant', 'a'), snapshot.experiment_revision
    FROM jsonb_array_elements(v_page_items) AS entries(item)
    JOIN public.feed_rank_snapshots snapshot ON snapshot.id = v_snapshot_id
    ON CONFLICT (snapshot_id, post_id) DO NOTHING;

    SELECT COALESCE(jsonb_agg(item || jsonb_build_object('exposure_id', exposure.id)
      ORDER BY ordinality), '[]'::jsonb) INTO v_page_items
    FROM jsonb_array_elements(v_page_items) WITH ORDINALITY AS entries(item, ordinality)
    JOIN public.feed_served_items exposure ON exposure.snapshot_id = v_snapshot_id
      AND exposure.post_id = (item->>'id')::uuid;
  END IF;

  IF v_has_more THEN
    INSERT INTO public.feed_rank_cursors (
      snapshot_id,
      viewer_id,
      next_position,
      expires_at
    )
    VALUES (
      v_snapshot_id,
      v_viewer_id,
      v_last_position,
      v_snapshot_expires_at
    )
    RETURNING token INTO v_next_cursor;
  END IF;

  RETURN jsonb_build_object(
    'items', v_page_items,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more,
    'snapshot_expires_at', v_snapshot_expires_at
  );
END;
$function$;

ALTER TABLE public.ml_interactions ADD COLUMN exposure_id uuid
  REFERENCES public.feed_served_items(id) ON DELETE SET NULL;
ALTER TABLE public.ml_interactions ADD COLUMN surface text NOT NULL DEFAULT 'legacy';
CREATE INDEX ml_interactions_user_recent ON public.ml_interactions(user_id, created_at DESC);
CREATE UNIQUE INDEX ml_interactions_exposure_signal
  ON public.ml_interactions(exposure_id, signal_type) WHERE exposure_id IS NOT NULL;
REVOKE INSERT, UPDATE, DELETE ON public.ml_interactions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.ml_feed_experiment_events FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_record_feed_ab_events(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_record_watch_time(uuid, numeric, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ml_ingest_feed_events(p_events jsonb)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  viewer uuid := auth.uid();
  event jsonb;
  event_id uuid;
  target_post uuid;
  exposure public.feed_served_items%ROWTYPE;
  signal text;
  weight numeric;
  dwell integer;
  inserted uuid;
  accepted integer := 0;
  recent_count integer;
BEGIN
  IF viewer IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) > 100 THEN
    RAISE EXCEPTION 'invalid event batch' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.privacy_settings p
    WHERE p.user_id = viewer AND p.analytics_enabled = true) THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('feed-events:' || viewer::text, 0));
  SELECT count(*) INTO recent_count FROM public.ml_interactions i
    WHERE i.user_id = viewer AND i.created_at >= now() - interval '1 hour';
  FOR event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    EXIT WHEN recent_count >= 600;
    BEGIN
      event_id := (event->>'event_id')::uuid;
      target_post := (event->>'post_id')::uuid;
      signal := event->>'event_type';
      dwell := LEAST(600000, GREATEST(0, COALESCE((event->>'dwell_ms')::integer, 0)));
      weight := CASE signal
        WHEN 'view' THEN 0.5 WHEN 'dwell_medium' THEN 1 WHEN 'dwell_long' THEN 1.5
        WHEN 'watch_complete' THEN 2.2 WHEN 'like' THEN 2 WHEN 'comment' THEN 3
        WHEN 'share' THEN 4 WHEN 'save' THEN 3.2 WHEN 'not_interested' THEN -4
        WHEN 'hide' THEN -3 WHEN 'report' THEN -5 WHEN 'skip_fast' THEN -1 WHEN 'click' THEN 1 END;
      IF event_id IS NULL OR target_post IS NULL OR weight IS NULL THEN CONTINUE; END IF;
      SELECT * INTO exposure FROM public.feed_served_items s
        WHERE s.id = (event->>'exposure_id')::uuid AND s.viewer_id = viewer
          AND s.post_id = target_post AND s.served_at >= now() - interval '40 minutes';
      IF NOT FOUND THEN CONTINUE; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.posts p LEFT JOIN public.privacy_settings privacy ON privacy.user_id = p.user_id
        WHERE p.id = target_post AND (p.expires_at IS NULL OR p.expires_at > now())
          AND (p.publish_at IS NULL OR p.publish_at <= now())
          AND (p.user_id = viewer OR (
            (COALESCE(privacy.profile_visibility, 'public') = 'public' AND COALESCE(privacy.posts_visibility, 'public') = 'public')
            OR (COALESCE(privacy.profile_visibility, 'public') IN ('public','friends')
              AND COALESCE(privacy.posts_visibility, 'public') IN ('public','friends') AND EXISTS (
                SELECT 1 FROM public.friendships f WHERE f.status = 'accepted'
                  AND ((f.requester_id = viewer AND f.addressee_id = p.user_id)
                    OR (f.addressee_id = viewer AND f.requester_id = p.user_id))
              ))
          ))
          AND NOT EXISTS (SELECT 1 FROM public.user_message_blocks b
            WHERE (b.blocker_user_id = viewer AND b.blocked_user_id = p.user_id)
              OR (b.blocker_user_id = p.user_id AND b.blocked_user_id = viewer))
      ) THEN CONTINUE; END IF;
      dwell := LEAST(dwell, GREATEST(0, (extract(epoch FROM (now() - exposure.served_at)) * 1000)::integer));
      IF signal IN ('dwell_medium','dwell_long','watch_complete') AND dwell < 1000 THEN CONTINUE; END IF;
      IF EXISTS (SELECT 1 FROM public.ml_interactions i WHERE i.user_id = viewer
        AND i.post_id = target_post AND i.signal_type = signal
        AND i.created_at > now() - interval '10 minutes') THEN CONTINUE; END IF;
      INSERT INTO public.ml_interactions(id,user_id,post_id,signal_type,weight,dwell_ms,exposure_id,surface)
        VALUES(event_id,viewer,target_post,signal,weight,dwell,exposure.id,'feed')
        ON CONFLICT DO NOTHING RETURNING id INTO inserted;
      IF inserted IS NULL THEN CONTINUE; END IF;
      INSERT INTO public.ml_feed_experiment_events(user_id,experiment_key,variant,post_id,event_type,surface,dwell_ms,weight,metadata)
        VALUES(viewer,'recsys_v8_main',exposure.variant,target_post,signal,'feed',dwell,weight,
          jsonb_build_object('event_id',event_id,'exposure_id',exposure.id,
            'experiment_revision',exposure.experiment_revision,'provenance','served'));
      accepted := accepted + 1;
      recent_count := recent_count + 1;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      CONTINUE;
    END;
  END LOOP;
  RETURN accepted;
END;
$function$;
REVOKE ALL ON FUNCTION public.ml_ingest_feed_events(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ml_ingest_feed_events(jsonb) TO authenticated;