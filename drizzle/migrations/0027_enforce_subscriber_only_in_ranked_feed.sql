-- Publications réservées aux abonnés : le fil classé est produit par des fonctions
-- SECURITY DEFINER qui contournent RLS. La règle d'accès (auteur ou fan actif) est
-- donc appliquée ici, sinon une publication réservée fuiterait chez les non-abonnés.
CREATE OR REPLACE FUNCTION public.feed_eligible_post_ids_internal(p_viewer_id uuid, p_post_ids uuid[])
 RETURNS TABLE(post_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
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
        NOT post.subscriber_only
        OR post.user_id = p_viewer_id
        OR public.is_active_fan(post.user_id, p_viewer_id)
      )
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

-- Le badge « abonnés » doit être visible sur la carte : la colonne est remontée
-- dans l'objet jsonb de chaque item du fil.
CREATE OR REPLACE FUNCTION public.get_ranked_feed_page(p_limit integer DEFAULT 25, p_cursor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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
        'subscriber_only', post.subscriber_only,
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