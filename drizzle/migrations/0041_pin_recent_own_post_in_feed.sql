-- A creator must immediately see their own newly published post at the top of
-- their smart feed. This is a presentation invariant for the author only; it
-- does not change candidate retrieval, model weights, experiments, or ranking
-- for any other viewer.
CREATE OR REPLACE FUNCTION public.finalize_feed_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  remaining jsonb := NEW.items;
  result jsonb := '[]'::jsonb;
  recent_authors text[] := ARRAY[]::text[];
  candidate jsonb;
  selected_index integer;
  own_recent_candidate jsonb;
  own_recent_index integer;
  feed_mode text;
  author_cap integer := 2;
BEGIN
  SELECT md5(e.variant_a::text || e.variant_b::text || e.traffic_split::text || e.updated_at::text)
    INTO NEW.experiment_revision
  FROM public.ml_feed_experiments AS e
  WHERE e.key = 'recsys_v8_main';

  SELECT preference.feed_algorithm
    INTO feed_mode
  FROM public.user_feed_preferences AS preference
  WHERE preference.user_id = NEW.viewer_id;

  -- Chronological and friends-first feeds already own their ordering contract.
  IF COALESCE(feed_mode, 'smart') <> 'smart' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(a.diversity_author_cap, 2)
    INTO author_cap
  FROM public.ml_recsys_v8_assignment(NEW.viewer_id, 'recsys_v8_main') AS a;

  -- Pin at most one eligible post: the viewer's newest publication from the
  -- last 15 minutes. The post is already part of the ranked candidate set and
  -- will still be rechecked by feed_eligible_post_ids_internal when served.
  IF NEW.viewer_id IS NOT NULL THEN
    SELECT
      (entry.ordinality - 1)::integer,
      entry.value
    INTO own_recent_index, own_recent_candidate
    FROM jsonb_array_elements(remaining) WITH ORDINALITY AS entry(value, ordinality)
    JOIN public.posts AS own_post
      ON own_post.id = (entry.value ->> 'id')::uuid
    WHERE own_post.user_id = NEW.viewer_id
      AND own_post.created_at >= now() - interval '15 minutes'
      AND (own_post.publish_at IS NULL OR own_post.publish_at <= now())
      AND (own_post.expires_at IS NULL OR own_post.expires_at > now())
    ORDER BY own_post.created_at DESC, entry.ordinality
    LIMIT 1;

    IF own_recent_candidate IS NOT NULL THEN
      own_recent_candidate := jsonb_set(
        own_recent_candidate,
        '{rank_reason}',
        to_jsonb('own_recent'::text),
        true
      );
      result := result || jsonb_build_array(own_recent_candidate);
      recent_authors := array_append(recent_authors, NEW.viewer_id::text);
      remaining := remaining - own_recent_index;
    END IF;
  END IF;

  -- Preserve the existing smart-feed diversity pass for every remaining item.
  WHILE jsonb_array_length(remaining) > 0 LOOP
    selected_index := NULL;
    candidate := NULL;

    SELECT
      (entry.ordinality - 1)::integer,
      entry.value
    INTO selected_index, candidate
    FROM jsonb_array_elements(remaining) WITH ORDINALITY AS entry(value, ordinality)
    WHERE (
      SELECT count(*)
      FROM unnest(recent_authors) AS author_id
      WHERE author_id = entry.value ->> 'user_id'
    ) < author_cap
    ORDER BY entry.ordinality
    LIMIT 1;

    IF selected_index IS NULL THEN
      selected_index := 0;
      candidate := remaining -> 0;
    END IF;

    result := result || jsonb_build_array(candidate);
    recent_authors := array_append(recent_authors, candidate ->> 'user_id');
    IF cardinality(recent_authors) > 11 THEN
      recent_authors := recent_authors[2:12];
    END IF;
    remaining := remaining - selected_index;
  END LOOP;

  NEW.items := result;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_feed_snapshot()
  FROM PUBLIC, anon, authenticated;