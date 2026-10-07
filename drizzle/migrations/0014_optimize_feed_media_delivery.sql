ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS media_thumbnail_url text;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'posts_media_thumbnail_url_https'
      AND conrelid = 'public.posts'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.posts
      ADD CONSTRAINT posts_media_thumbnail_url_https
      CHECK (
        media_thumbnail_url IS NULL
        OR (
          pg_catalog.length(media_thumbnail_url) <= 2048
          AND media_thumbnail_url ~ '^https://'
        )
      );
  END IF;
END;
$block$;

COMMENT ON COLUMN public.posts.media_thumbnail_url IS
  'Lightweight public poster for feed video paint; never an Aegis message attachment.';

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
    RETURNING id INTO v_snapshot_id;

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

REVOKE ALL ON FUNCTION public.get_ranked_feed_page(integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ranked_feed_page(integer, uuid)
  TO anon, authenticated, service_role;