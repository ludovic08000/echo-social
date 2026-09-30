-- Make every user-facing settings control effective at the data boundary.

-- Content/AI preferences follow the account instead of only this browser.
ALTER TABLE public.user_feed_preferences
  ADD COLUMN IF NOT EXISTS ai_summaries_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_translate_enabled boolean NOT NULL DEFAULT false;

-- Every post without a recognised topic is classified as "general". Keep it
-- enabled for existing protected accounts so activating the server-side filter
-- cannot accidentally produce an empty feed after this migration.
ALTER TABLE public.parental_controls
  ALTER COLUMN allowed_categories SET DEFAULT ARRAY[
    'general', 'education', 'sport', 'gaming', 'musique', 'art', 'humour'
  ]::text[];

UPDATE public.parental_controls
SET allowed_categories = ARRAY['general']::text[] || allowed_categories,
    updated_at = now()
WHERE NOT ('general' = ANY(COALESCE(allowed_categories, ARRAY[]::text[])));

REVOKE ALL ON TABLE public.user_feed_preferences FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_feed_preferences TO authenticated;
GRANT ALL ON TABLE public.user_feed_preferences TO service_role;

-- Privacy-preserving presence. A user can only see rows allowed by the
-- row owner's online visibility preference.
CREATE TABLE IF NOT EXISTS public.user_online_presence (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_online_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_online_presence REPLICA IDENTITY FULL;
REVOKE ALL ON TABLE public.user_online_presence FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_online_presence TO authenticated;
GRANT ALL ON TABLE public.user_online_presence TO service_role;

-- The helper evaluates only the caller's own access. It is SECURITY DEFINER so
-- privacy/friendship RLS cannot accidentally turn a private setting into the
-- permissive default while it is used from another table's policy.
CREATE OR REPLACE FUNCTION public.privacy_scope_allows(
  p_owner_user_id uuid,
  p_scope text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_is_friend boolean := false;
  v_value text;
  v_ghost boolean := false;
BEGIN
  IF p_owner_user_id IS NULL THEN RETURN false; END IF;
  IF v_viewer = p_owner_user_id THEN RETURN true; END IF;

  IF v_viewer IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.friendships AS friendship
      WHERE friendship.status = 'accepted'
        AND (
          (friendship.requester_id = v_viewer AND friendship.addressee_id = p_owner_user_id)
          OR (friendship.addressee_id = v_viewer AND friendship.requester_id = p_owner_user_id)
        )
    ) INTO v_is_friend;
  END IF;

  SELECT
    CASE p_scope
      WHEN 'profile' THEN settings.profile_visibility
      WHEN 'posts' THEN settings.posts_visibility
      WHEN 'friends' THEN settings.friends_list_visibility
      WHEN 'online' THEN settings.online_status_visibility
      WHEN 'comments' THEN settings.comments_allowed
      WHEN 'wall' THEN settings.wall_visibility
      WHEN 'likes' THEN settings.likes_visibility
      ELSE 'nobody'
    END,
    COALESCE(settings.ghost_mode, false)
  INTO v_value, v_ghost
  FROM public.privacy_settings AS settings
  WHERE settings.user_id = p_owner_user_id;

  v_value := COALESCE(v_value, CASE p_scope
    WHEN 'profile' THEN 'public'
    WHEN 'posts' THEN 'public'
    WHEN 'friends' THEN 'friends'
    WHEN 'online' THEN 'friends'
    WHEN 'comments' THEN 'everyone'
    WHEN 'wall' THEN 'friends'
    WHEN 'likes' THEN 'public'
    ELSE 'nobody'
  END);

  IF p_scope = 'online' AND v_ghost THEN RETURN false; END IF;
  IF v_value IN ('public', 'everyone') THEN RETURN true; END IF;
  IF v_value = 'friends' THEN RETURN v_is_friend; END IF;
  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.privacy_scope_allows(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_scope_allows(uuid, text) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "presence visible by privacy" ON public.user_online_presence;
DROP POLICY IF EXISTS "owner inserts presence" ON public.user_online_presence;
DROP POLICY IF EXISTS "owner updates presence" ON public.user_online_presence;
DROP POLICY IF EXISTS "owner deletes presence" ON public.user_online_presence;

CREATE POLICY "presence visible by privacy"
ON public.user_online_presence FOR SELECT TO authenticated
USING (
  auth.uid() = user_id
  OR public.privacy_scope_allows(user_online_presence.user_id, 'online')
);

CREATE POLICY "owner inserts presence"
ON public.user_online_presence FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner updates presence"
ON public.user_online_presence FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner deletes presence"
ON public.user_online_presence FOR DELETE TO authenticated
USING (auth.uid() = user_id);

DO $publication$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'user_online_presence'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_online_presence;
  END IF;
END
$publication$;

-- Expose only the non-secret privacy flags needed to render another profile.
CREATE OR REPLACE FUNCTION public.get_profile_privacy(p_user_id uuid)
RETURNS TABLE(
  profile_visibility text,
  posts_visibility text,
  friends_list_visibility text,
  wall_visibility text,
  search_engine_indexing boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    COALESCE(settings.profile_visibility, 'public'),
    COALESCE(settings.posts_visibility, 'public'),
    COALESCE(settings.friends_list_visibility, 'friends'),
    COALESCE(settings.wall_visibility, 'friends'),
    COALESCE(settings.search_engine_indexing, false)
  FROM (SELECT p_user_id AS user_id) AS requested
  LEFT JOIN public.privacy_settings AS settings USING (user_id);
$function$;

REVOKE ALL ON FUNCTION public.get_profile_privacy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_profile_privacy(uuid) TO anon, authenticated, service_role;

-- The historical profile RPC already redacts per-field visibility, but it did
-- not enforce the account-level profile visibility. Keep its field-redaction
-- implementation private and place an account-level guard in front of it.
DO $profile_rpc_guard$
BEGIN
  IF pg_catalog.to_regprocedure('public.get_profile_for_viewer_redacted(uuid)') IS NULL THEN
    ALTER FUNCTION public.get_profile_for_viewer(uuid)
      RENAME TO get_profile_for_viewer_redacted;
  END IF;
END
$profile_rpc_guard$;

REVOKE ALL ON FUNCTION public.get_profile_for_viewer_redacted(uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_profile_for_viewer(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_viewer = p_user_id
     OR (v_viewer IS NOT NULL AND public.has_role(v_viewer, 'admin'::public.app_role))
     OR public.privacy_scope_allows(p_user_id, 'profile') THEN
    RETURN public.get_profile_for_viewer_redacted(p_user_id);
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_profile_for_viewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_profile_for_viewer(uuid)
TO anon, authenticated, service_role;

-- Direct Data API reads follow the same account-level boundary. The existing
-- column grants still keep private/server-owned profile columns unavailable.
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;
DROP POLICY IF EXISTS "Guests can view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Profiles respect account privacy" ON public.profiles;
CREATE POLICY "Profiles respect account privacy"
ON public.profiles FOR SELECT
USING (
  auth.uid() = user_id
  OR public.privacy_scope_allows(profiles.user_id, 'profile')
  OR (auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin'::public.app_role))
);

-- Friend lists are exposed through narrow RPCs. This makes a public/friends
-- setting actually useful without weakening the base friendships RLS policy.
CREATE OR REPLACE FUNCTION public.get_visible_profile_friends(
  p_user_id uuid,
  p_limit integer DEFAULT 6
)
RETURNS TABLE(user_id uuid, name text, avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_limit integer := LEAST(60, GREATEST(1, COALESCE(p_limit, 6)));
BEGIN
  IF p_user_id IS NULL OR NOT (
    auth.uid() = p_user_id
    OR public.privacy_scope_allows(p_user_id, 'friends')
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT
    profile.user_id,
    profile.name,
    profile.avatar_url
  FROM public.friendships AS friendship
  JOIN public.profiles AS profile
    ON profile.user_id = CASE
      WHEN friendship.requester_id = p_user_id THEN friendship.addressee_id
      ELSE friendship.requester_id
    END
  WHERE friendship.status = 'accepted'
    AND (friendship.requester_id = p_user_id OR friendship.addressee_id = p_user_id)
    AND public.privacy_scope_allows(profile.user_id, 'profile')
  ORDER BY profile.name, profile.user_id
  LIMIT v_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_visible_profile_friends(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visible_profile_friends(uuid, integer)
TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_visible_profile_friend_count(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_user_id IS NULL OR NOT (
    auth.uid() = p_user_id
    OR public.privacy_scope_allows(p_user_id, 'friends')
  ) THEN
    RETURN 0;
  END IF;

  RETURN (
    SELECT pg_catalog.count(*)::integer
    FROM public.friendships AS friendship
    WHERE friendship.status = 'accepted'
      AND (friendship.requester_id = p_user_id OR friendship.addressee_id = p_user_id)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_visible_profile_friend_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visible_profile_friend_count(uuid)
TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_visible_mutual_friends(
  p_user_id uuid,
  p_limit integer DEFAULT 3
)
RETURNS TABLE(id uuid, user_id uuid, name text, avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_limit integer := LEAST(12, GREATEST(1, COALESCE(p_limit, 3)));
BEGIN
  IF v_viewer IS NULL OR p_user_id IS NULL OR v_viewer = p_user_id
     OR NOT public.privacy_scope_allows(p_user_id, 'friends') THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH viewer_friends AS (
    SELECT CASE
      WHEN friendship.requester_id = v_viewer THEN friendship.addressee_id
      ELSE friendship.requester_id
    END AS friend_id
    FROM public.friendships AS friendship
    WHERE friendship.status = 'accepted'
      AND (friendship.requester_id = v_viewer OR friendship.addressee_id = v_viewer)
  ), target_friends AS (
    SELECT CASE
      WHEN friendship.requester_id = p_user_id THEN friendship.addressee_id
      ELSE friendship.requester_id
    END AS friend_id
    FROM public.friendships AS friendship
    WHERE friendship.status = 'accepted'
      AND (friendship.requester_id = p_user_id OR friendship.addressee_id = p_user_id)
  )
  SELECT profile.id, profile.user_id, profile.name, profile.avatar_url
  FROM viewer_friends
  JOIN target_friends USING (friend_id)
  JOIN public.profiles AS profile ON profile.user_id = viewer_friends.friend_id
  WHERE public.privacy_scope_allows(profile.user_id, 'profile')
  ORDER BY profile.name, profile.user_id
  LIMIT v_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_visible_mutual_friends(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visible_mutual_friends(uuid, integer)
TO authenticated, service_role;

-- Safe public signal for UI protections. The PIN hash and control details stay
-- private; callers only learn whether the protected-contact rules apply.
CREATE OR REPLACE FUNCTION public.is_user_protected_minor(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.parental_controls AS controls
    WHERE controls.user_id = p_user_id
      AND controls.is_active = true
      AND controls.is_minor = true
  );
$function$;

REVOKE ALL ON FUNCTION public.is_user_protected_minor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_user_protected_minor(uuid) TO authenticated, service_role;

-- Deterministic, local classification for parental filtering. ML topics enrich
-- the decision when available; the body fallback also protects older posts.
CREATE OR REPLACE FUNCTION public.parental_content_category_allowed(
  p_body text,
  p_topics text[],
  p_hashtags text[],
  p_allowed_categories text[]
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  v_text text := pg_catalog.lower(pg_catalog.concat_ws(
    ' ',
    COALESCE(p_body, ''),
    pg_catalog.array_to_string(COALESCE(p_topics, ARRAY[]::text[]), ' '),
    pg_catalog.array_to_string(COALESCE(p_hashtags, ARRAY[]::text[]), ' ')
  ));
  v_detected text[] := ARRAY[]::text[];
  v_allowed text[] := COALESCE(p_allowed_categories, ARRAY[]::text[]);
BEGIN
  IF v_text ~ '(education|éducation|ecole|école|cours|apprendre|science|histoire|math|tutoriel)' THEN
    v_detected := pg_catalog.array_append(v_detected, 'education');
  END IF;
  IF v_text ~ '(sport|football|basket|tennis|rugby|fitness|course à pied|cyclisme)' THEN
    v_detected := pg_catalog.array_append(v_detected, 'sport');
  END IF;
  IF v_text ~ '(gaming|jeu vidéo|jeux vidéo|gameplay|esport|playstation|xbox|nintendo)' THEN
    v_detected := pg_catalog.array_append(v_detected, 'gaming');
  END IF;
  IF v_text ~ '(musique|music|chanson|concert|album|guitare|piano|rap|rock)' THEN
    v_detected := pg_catalog.array_append(v_detected, 'musique');
  END IF;
  IF v_text ~ '(dessin|peinture|artiste|photographie|sculpture|illustration|musée|musee)' THEN
    v_detected := pg_catalog.array_append(v_detected, 'art');
  END IF;
  IF v_text ~ '(humour|humor|blague|drôle|drole|meme|mème|comédie|comedie)' THEN
    v_detected := pg_catalog.array_append(v_detected, 'humour');
  END IF;

  IF pg_catalog.cardinality(v_detected) = 0 THEN
    v_detected := ARRAY['general']::text[];
  END IF;

  RETURN v_detected && v_allowed;
END;
$function$;

REVOKE ALL ON FUNCTION public.parental_content_category_allowed(text, text[], text[], text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parental_content_category_allowed(text, text[], text[], text[])
  TO service_role;

-- RLS-safe wrapper for direct post reads. The viewer is always taken from the
-- JWT, so a browser cannot ask whether content would be allowed for somebody
-- else's parental profile.
CREATE OR REPLACE FUNCTION public.current_viewer_parental_post_allowed(
  p_post_id uuid,
  p_body text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_allowed text[];
  v_topics text[] := ARRAY[]::text[];
  v_hashtags text[] := ARRAY[]::text[];
  v_sensitivity numeric := 0;
BEGIN
  IF v_viewer IS NULL THEN RETURN true; END IF;

  SELECT controls.allowed_categories
  INTO v_allowed
  FROM public.parental_controls AS controls
  WHERE controls.user_id = v_viewer
    AND controls.is_active = true
    AND controls.is_minor = true;

  IF v_allowed IS NULL THEN RETURN true; END IF;

  SELECT
    COALESCE(feature.topics, ARRAY[]::text[]),
    COALESCE(feature.hashtags, ARRAY[]::text[]),
    COALESCE(feature.content_sensitivity_score, 0)
  INTO v_topics, v_hashtags, v_sensitivity
  FROM public.ml_post_features AS feature
  WHERE feature.post_id = p_post_id;

  v_topics := COALESCE(v_topics, ARRAY[]::text[]);
  v_hashtags := COALESCE(v_hashtags, ARRAY[]::text[]);
  v_sensitivity := COALESCE(v_sensitivity, 0);

  RETURN v_sensitivity <= 0.35
    AND public.parental_content_category_allowed(p_body, v_topics, v_hashtags, v_allowed);
END;
$function$;

REVOKE ALL ON FUNCTION public.current_viewer_parental_post_allowed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_viewer_parental_post_allowed(uuid, text)
  TO anon, authenticated, service_role;

-- Replace the set-wise feed boundary so parental rules are checked both when a
-- ranked snapshot is created and again for every cursor page.
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

REVOKE ALL ON FUNCTION public.feed_eligible_post_ids_internal(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.feed_priority_topic_matches(
  p_priority_topics text[],
  p_topics text[],
  p_hashtags text[],
  p_body text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  v_topic text;
  v_normalized text;
  v_text text := pg_catalog.lower(pg_catalog.concat_ws(
    ' ',
    COALESCE(p_body, ''),
    pg_catalog.array_to_string(COALESCE(p_topics, ARRAY[]::text[]), ' '),
    pg_catalog.array_to_string(COALESCE(p_hashtags, ARRAY[]::text[]), ' ')
  ));
BEGIN
  FOREACH v_topic IN ARRAY COALESCE(p_priority_topics, ARRAY[]::text[])
  LOOP
    v_normalized := CASE pg_catalog.lower(v_topic)
      WHEN 'content.topictech' THEN 'technology'
      WHEN 'content.topicsport' THEN 'sport'
      WHEN 'content.topicart' THEN 'art'
      WHEN 'content.topicmusic' THEN 'music'
      WHEN 'content.topiccooking' THEN 'cooking'
      WHEN 'content.topictravel' THEN 'travel'
      WHEN 'content.topicscience' THEN 'science'
      WHEN 'content.topicfashion' THEN 'fashion'
      WHEN 'content.topiccinema' THEN 'cinema'
      WHEN 'content.topicliterature' THEN 'literature'
      WHEN 'content.topicgaming' THEN 'gaming'
      WHEN 'content.topicnature' THEN 'nature'
      ELSE pg_catalog.lower(v_topic)
    END;

    IF (v_normalized = 'technology' AND v_text ~ '(tech|technologie|informatique|numérique|numerique)')
      OR (v_normalized = 'sport' AND v_text ~ '(sport|football|basket|tennis|rugby|fitness)')
      OR (v_normalized = 'art' AND v_text ~ '(art|dessin|peinture|photo|sculpture|illustration)')
      OR (v_normalized = 'music' AND v_text ~ '(music|musique|chanson|concert|album|rap|rock)')
      OR (v_normalized = 'cooking' AND v_text ~ '(cooking|cuisine|recette|restaurant|gastronomie)')
      OR (v_normalized = 'travel' AND v_text ~ '(travel|voyage|tourisme|vacances|destination)')
      OR (v_normalized = 'science' AND v_text ~ '(science|recherche|physique|biologie|espace)')
      OR (v_normalized = 'fashion' AND v_text ~ '(fashion|mode|vêtement|vetement|style)')
      OR (v_normalized = 'cinema' AND v_text ~ '(cinema|cinéma|film|série|serie)')
      OR (v_normalized = 'literature' AND v_text ~ '(literature|littérature|livre|roman|lecture)')
      OR (v_normalized = 'gaming' AND v_text ~ '(gaming|jeu vidéo|jeux vidéo|gameplay|esport)')
      OR (v_normalized = 'nature' AND v_text ~ '(nature|animal|écologie|ecologie|environnement)')
    THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.feed_priority_topic_matches(text[], text[], text[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_priority_topic_matches(text[], text[], text[], text)
  TO service_role;

-- Explicit content preferences are applied to the immutable ranked snapshot.
-- The underlying RecSys weights and A/B assignment remain unchanged; this is a
-- small deterministic user-controlled rerank over at most 200 candidates.
CREATE OR REPLACE FUNCTION public.apply_feed_preferences_to_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_preference public.user_feed_preferences%ROWTYPE;
BEGIN
  IF NEW.viewer_id IS NULL OR pg_catalog.jsonb_array_length(NEW.items) < 2 THEN
    RETURN NEW;
  END IF;

  SELECT preference.*
  INTO v_preference
  FROM public.user_feed_preferences AS preference
  WHERE preference.user_id = NEW.viewer_id;

  IF NOT FOUND THEN RETURN NEW; END IF;

  WITH expanded AS MATERIALIZED (
    SELECT entry.value, entry.ordinality
    FROM pg_catalog.jsonb_array_elements(NEW.items) WITH ORDINALITY AS entry(value, ordinality)
  ),
  enriched AS MATERIALIZED (
    SELECT
      expanded.value,
      expanded.ordinality,
      COALESCE((expanded.value ->> 'is_friend')::boolean, false) AS is_friend,
      COALESCE(NULLIF(expanded.value ->> 'final_score', '')::numeric, 0) AS base_score,
      COALESCE(NULLIF(expanded.value ->> 'created_at', '')::timestamptz, '-infinity'::timestamptz) AS created_at,
      COALESCE(feature.novelty_score, 0.5) AS novelty,
      COALESCE(feature.engagement_velocity, 0) AS engagement_velocity,
      public.feed_priority_topic_matches(
        v_preference.priority_topics,
        feature.topics,
        feature.hashtags,
        post.body
      ) AS topic_match
    FROM expanded
    LEFT JOIN public.posts AS post
      ON post.id = (expanded.value ->> 'id')::uuid
    LEFT JOIN public.ml_post_features AS feature
      ON feature.post_id = post.id
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(enriched.value ORDER BY
      CASE
        WHEN v_preference.feed_algorithm = 'chronological' THEN enriched.created_at
      END DESC NULLS LAST,
      CASE
        WHEN v_preference.feed_algorithm = 'friends_first'
          THEN CASE WHEN enriched.is_friend THEN 1 ELSE 0 END
      END DESC NULLS LAST,
      CASE
        WHEN v_preference.feed_algorithm <> 'chronological' THEN
          enriched.base_score
          + CASE WHEN enriched.is_friend
              THEN COALESCE(v_preference.weight_friends, 60) * 0.12
              ELSE 0
            END
          + enriched.novelty * COALESCE(v_preference.weight_discovery, 30) * 0.12
          + CASE WHEN enriched.topic_match THEN 14 ELSE 0 END
          + enriched.novelty * ((COALESCE(v_preference.diversity_boost, 50) - 50) / 50.0) * 10
          - CASE WHEN COALESCE(v_preference.viral_content_reduce, false)
              THEN LEAST(15, pg_catalog.ln(1 + GREATEST(0, enriched.engagement_velocity)) * 3)
              ELSE 0
            END
      END DESC NULLS LAST,
      enriched.ordinality
    ),
    '[]'::jsonb
  )
  INTO NEW.items
  FROM enriched;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_feed_preferences_to_snapshot()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_feed_preferences_to_snapshot()
  TO service_role;

DROP TRIGGER IF EXISTS apply_feed_preferences_to_snapshot
  ON public.feed_rank_snapshots;
CREATE TRIGGER apply_feed_preferences_to_snapshot
BEFORE INSERT ON public.feed_rank_snapshots
FOR EACH ROW EXECUTE FUNCTION public.apply_feed_preferences_to_snapshot();

-- Enforce "who can message me" in the same trusted helper used by direct
-- routing and message insertion. Privacy denials intentionally share the
-- recipient_block result so no private preference is disclosed to senders.
CREATE OR REPLACE FUNCTION public.aegis_message_block_reason(
  p_sender_user_id uuid,
  p_recipient_user_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT CASE
    WHEN p_sender_user_id IS NULL
      OR p_recipient_user_id IS NULL
      OR p_sender_user_id = p_recipient_user_id THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.user_message_blocks AS block
      WHERE block.blocker_user_id = p_recipient_user_id
        AND block.blocked_user_id = p_sender_user_id
    ) THEN 'recipient_block'
    WHEN EXISTS (
      SELECT 1 FROM public.user_message_blocks AS block
      WHERE block.blocker_user_id = p_sender_user_id
        AND block.blocked_user_id = p_recipient_user_id
    ) THEN 'sender_block'
    WHEN COALESCE((
      SELECT settings.messages_allowed
      FROM public.privacy_settings AS settings
      WHERE settings.user_id = p_recipient_user_id
    ), 'everyone') = 'nobody' THEN 'recipient_block'
    WHEN COALESCE((
      SELECT settings.messages_allowed
      FROM public.privacy_settings AS settings
      WHERE settings.user_id = p_recipient_user_id
    ), 'everyone') = 'friends'
      AND NOT EXISTS (
        SELECT 1 FROM public.friendships AS friendship
        WHERE friendship.status = 'accepted'
          AND (
            (friendship.requester_id = p_sender_user_id AND friendship.addressee_id = p_recipient_user_id)
            OR (friendship.addressee_id = p_sender_user_id AND friendship.requester_id = p_recipient_user_id)
          )
      ) THEN 'recipient_block'
    ELSE NULL
  END;
$function$;

REVOKE ALL ON FUNCTION public.aegis_message_block_reason(uuid, uuid)
FROM PUBLIC, anon, authenticated;

-- Posts are no longer directly readable when their owner's settings deny it.
DROP POLICY IF EXISTS "Posts are viewable by everyone" ON public.posts;
DROP POLICY IF EXISTS "Guests can view posts" ON public.posts;
DROP POLICY IF EXISTS "Posts respect owner privacy" ON public.posts;
CREATE POLICY "Posts respect owner privacy"
ON public.posts FOR SELECT
USING (
  auth.uid() = user_id
  OR (
    public.privacy_scope_allows(posts.user_id, 'profile')
    AND public.privacy_scope_allows(posts.user_id, 'posts')
    AND public.current_viewer_parental_post_allowed(posts.id, posts.body)
  )
);

-- The identity of a liker follows that user's preference. Aggregate counters
-- remain available on posts, so hiding the row does not break engagement UI.
DROP POLICY IF EXISTS "Likes are viewable by everyone" ON public.likes;
DROP POLICY IF EXISTS "Likes respect owner privacy" ON public.likes;
CREATE POLICY "Likes respect owner privacy"
ON public.likes FOR SELECT TO authenticated
USING (
  auth.uid() = user_id
  OR public.privacy_scope_allows(likes.user_id, 'likes')
);

-- Enforce anonymous-wall write access at the database boundary, not only by
-- hiding the composer in React.
DROP POLICY IF EXISTS "Authenticated users can post on walls" ON public.anonymous_wall_messages;
DROP POLICY IF EXISTS "Wall writes respect owner privacy" ON public.anonymous_wall_messages;
CREATE POLICY "Wall writes respect owner privacy"
ON public.anonymous_wall_messages FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = author_id
  AND (
    auth.uid() = target_user_id
    OR public.privacy_scope_allows(target_user_id, 'wall')
  )
);

REVOKE SELECT ON TABLE public.anonymous_wall_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, target_user_id, message, is_approved, created_at)
ON public.anonymous_wall_messages TO authenticated;

-- Comment creation obeys the post owner's interaction preference.
DROP POLICY IF EXISTS "Authenticated users can create comments" ON public.comments;
DROP POLICY IF EXISTS "Comments respect owner preference" ON public.comments;
CREATE POLICY "Comments respect owner preference"
ON public.comments FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1
    FROM public.posts AS post
    WHERE post.id = comments.post_id
      AND (
        post.user_id = auth.uid()
        OR public.privacy_scope_allows(post.user_id, 'comments')
      )
  )
);

-- Comment rows cannot reveal posts hidden by the owner.
DROP POLICY IF EXISTS "Comments are viewable by everyone" ON public.comments;
DROP POLICY IF EXISTS "Guests can view comments" ON public.comments;
DROP POLICY IF EXISTS "Comments follow post visibility" ON public.comments;
CREATE POLICY "Comments follow post visibility"
ON public.comments FOR SELECT
USING (EXISTS (SELECT 1 FROM public.posts AS post WHERE post.id = comments.post_id));

-- Push dispatch is server-authenticated and content blind. Database events send
-- only a recipient id and a fixed event kind; the Edge Function builds the
-- privacy-safe title/body/route.
CREATE OR REPLACE FUNCTION public.dispatch_aegis_push(
  p_user_id uuid,
  p_kind text,
  p_require_interaction boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_service_secret text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT secret.decrypted_secret
  INTO v_service_secret
  FROM vault.decrypted_secrets AS secret
  WHERE secret.name IN ('email_queue_service_role_key', 'service_role_key')
  ORDER BY CASE WHEN secret.name = 'email_queue_service_role_key' THEN 0 ELSE 1 END
  LIMIT 1;

  IF v_service_secret IS NULL OR pg_catalog.length(v_service_secret) = 0 THEN
    RAISE NOTICE 'Vault service credential missing; skipping privacy-safe push';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://vkpmoqfzrihcijjochks.supabase.co/functions/v1/push-notify',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_secret,
      'apikey', v_service_secret,
      'Content-Type', 'application/json'
    ),
    body := pg_catalog.jsonb_build_object(
      'user_id', p_user_id,
      'kind', p_kind,
      'requireInteraction', p_require_interaction
    ),
    timeout_milliseconds := 5000
  );
EXCEPTION WHEN OTHERS THEN
  -- Push delivery is best-effort and must never roll back the source event.
  RAISE NOTICE 'Privacy-safe push dispatch failed';
END;
$function$;

REVOKE ALL ON FUNCTION public.dispatch_aegis_push(uuid, text, boolean)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_aegis_push(uuid, text, boolean)
TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_notification_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_kind text;
BEGIN
  v_kind := CASE NEW.type::text
    WHEN 'like' THEN 'like'
    WHEN 'reaction' THEN 'reaction'
    WHEN 'comment' THEN 'comment'
    WHEN 'friend_request' THEN 'friend_request'
    WHEN 'friend_accepted' THEN 'friend_request'
    WHEN 'message' THEN 'message'
    WHEN 'story_view' THEN 'story_view'
    WHEN 'close_friend_post' THEN 'close_friend_post'
    WHEN 'sale' THEN 'sale'
    WHEN 'new_device' THEN 'new_device'
    ELSE 'notification'
  END;

  PERFORM public.dispatch_aegis_push(NEW.user_id, v_kind, false);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.dispatch_notification_push()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_dispatch_notification_push ON public.notifications;
CREATE TRIGGER trg_dispatch_notification_push
AFTER INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.dispatch_notification_push();

-- Replace the legacy unauthenticated call push with the same trusted path.
CREATE OR REPLACE FUNCTION public.notify_incoming_call_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status = 'ringing' THEN
    PERFORM public.dispatch_aegis_push(NEW.callee_id, 'call_incoming', true);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.notify_incoming_call_push()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notify_incoming_call_push ON public.active_calls;
CREATE TRIGGER trg_notify_incoming_call_push
AFTER INSERT ON public.active_calls
FOR EACH ROW EXECUTE FUNCTION public.notify_incoming_call_push();

-- Daily email digest. It contains only an aggregate count and a link to the
-- application: no actor, message text, post text or cryptographic metadata.
CREATE TABLE IF NOT EXISTS public.notification_digest_dispatches (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_date date NOT NULL,
  notification_count integer NOT NULL CHECK (notification_count > 0),
  queued_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, digest_date)
);

ALTER TABLE public.notification_digest_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_digest_dispatches
FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.notification_digest_dispatches
TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_notification_email_digests()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_recipient record;
  v_token text;
  v_token_used_at timestamptz;
  v_message_id text;
  v_digest_date date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
  v_queued integer := 0;
BEGIN
  FOR v_recipient IN
    SELECT
      account.id AS user_id,
      pg_catalog.lower(account.email) AS email,
      pg_catalog.count(notification.id)::integer AS notification_count
    FROM auth.users AS account
    JOIN public.notification_settings AS settings
      ON settings.user_id = account.id
     AND settings.email_notifications_enabled = true
    JOIN public.notifications AS notification
      ON notification.user_id = account.id
     AND notification.read_at IS NULL
     AND notification.created_at >= pg_catalog.now() - interval '24 hours'
    WHERE account.email IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.suppressed_emails AS suppressed
        WHERE pg_catalog.lower(suppressed.email) = pg_catalog.lower(account.email)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.notification_digest_dispatches AS dispatch
        WHERE dispatch.user_id = account.id
          AND dispatch.digest_date = v_digest_date
      )
    GROUP BY account.id, account.email
  LOOP
    BEGIN
      SELECT token.token, token.used_at
      INTO v_token, v_token_used_at
      FROM public.email_unsubscribe_tokens AS token
      WHERE pg_catalog.lower(token.email) = v_recipient.email
      LIMIT 1;

      IF v_token IS NULL THEN
        v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
        INSERT INTO public.email_unsubscribe_tokens (token, email)
        VALUES (v_token, v_recipient.email)
        ON CONFLICT (email) DO NOTHING;

        SELECT token.token, token.used_at
        INTO v_token, v_token_used_at
        FROM public.email_unsubscribe_tokens AS token
        WHERE token.email = v_recipient.email
        LIMIT 1;
      END IF;

      -- A used token represents an opt-out. Never silently reactivate it.
      IF v_token IS NULL OR v_token_used_at IS NOT NULL THEN
        CONTINUE;
      END IF;

      INSERT INTO public.notification_digest_dispatches (
        user_id,
        digest_date,
        notification_count
      ) VALUES (
        v_recipient.user_id,
        v_digest_date,
        v_recipient.notification_count
      ) ON CONFLICT DO NOTHING;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      v_message_id := pg_catalog.gen_random_uuid()::text;
      PERFORM pgmq.send(
        'transactional_emails',
        pg_catalog.jsonb_build_object(
          'message_id', v_message_id,
          'user_id', v_recipient.user_id,
          'preference_key', 'notification_digest',
          'to', v_recipient.email,
          'from', 'ForSure <noreply@notify.forsure.fans>',
          'sender_domain', 'notify.forsure.fans',
          'subject', 'Votre résumé ForSure',
          'html', pg_catalog.format(
            '<!doctype html><html lang="fr"><body style="font-family:Arial,sans-serif;color:#172033"><h1>Votre résumé ForSure</h1><p>Vous avez %s notification(s) non lue(s).</p><p><a href="https://forsure.fans/notifications">Voir mes notifications</a></p><p>Vous pouvez désactiver ce résumé dans Paramètres → Notifications.</p></body></html>',
            v_recipient.notification_count
          ),
          'text', pg_catalog.format(
            'Vous avez %s notification(s) non lue(s). Consultez-les sur https://forsure.fans/notifications. Vous pouvez désactiver ce résumé dans Paramètres > Notifications.',
            v_recipient.notification_count
          ),
          'purpose', 'transactional',
          'label', 'notification_digest',
          'idempotency_key', 'notification-digest:' || v_recipient.user_id::text || ':' || v_digest_date::text,
          'unsubscribe_token', v_token,
          'queued_at', pg_catalog.now()
        )
      );

      INSERT INTO public.email_send_log (
        message_id,
        template_name,
        recipient_email,
        status
      ) VALUES (
        v_message_id,
        'notification_digest',
        v_recipient.email,
        'pending'
      );

      v_queued := v_queued + 1;
    EXCEPTION WHEN OTHERS THEN
      -- The subtransaction rolls back this recipient's dispatch marker and
      -- queue write, allowing a later cron run to retry safely.
      RAISE NOTICE 'Notification digest enqueue skipped for one recipient';
    END;
  END LOOP;

  RETURN v_queued;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_notification_email_digests()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_notification_email_digests()
TO service_role;

DO $schedule_notification_digest$
DECLARE
  v_job record;
BEGIN
  IF pg_catalog.to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron unavailable; notification digest schedule not installed';
    RETURN;
  END IF;

  FOR v_job IN EXECUTE
    'SELECT jobid FROM cron.job WHERE jobname = $1'
    USING 'forsure-notification-digest-daily'
  LOOP
    EXECUTE 'SELECT cron.unschedule($1)' USING v_job.jobid;
  END LOOP;

  EXECUTE 'SELECT cron.schedule($1, $2, $3)'
  USING
    'forsure-notification-digest-daily',
    '0 8 * * *',
    'SELECT public.enqueue_notification_email_digests();';
END;
$schedule_notification_digest$;
