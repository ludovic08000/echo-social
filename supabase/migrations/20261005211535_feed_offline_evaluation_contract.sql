BEGIN;

-- Reuse short-lived serving snapshots. No new long-term personal-data store.
ALTER TABLE public.feed_rank_snapshots ADD COLUMN evaluation_context jsonb;
CREATE INDEX feed_snapshots_evaluation_recent
  ON public.feed_rank_snapshots(created_at DESC, id) WHERE evaluation_context IS NOT NULL;

-- Preserve the existing algorithm exactly; capture the policy already read by it.
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
  NEW.evaluation_context := jsonb_build_object('mode', COALESCE(feed_mode,'smart'), 'author_cap', 2);
  IF COALESCE(feed_mode, 'smart') <> 'smart' THEN RETURN NEW; END IF;
  SELECT COALESCE(a.diversity_author_cap, 2) INTO author_cap
    FROM public.ml_recsys_v8_assignment(NEW.viewer_id, 'recsys_v8_main') a;
  NEW.evaluation_context := jsonb_build_object('mode', 'smart', 'author_cap', author_cap);
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
REVOKE ALL ON FUNCTION public.finalize_feed_snapshot() FROM PUBLIC,anon,authenticated;

-- Service-only, read-only, bounded export of observed slates. Never callable by a browser.
-- Feedback has an equal five-minute observation window. Missing feedback is not a dislike.
CREATE FUNCTION public.feed_evaluation_slates(p_limit integer DEFAULT 50,p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE result jsonb;
BEGIN
  IF p_as_of IS NULL OR p_as_of > now() OR p_as_of < now()-interval '1 hour' THEN
    RAISE EXCEPTION 'invalid evaluation time' USING ERRCODE='22023';
  END IF;
  WITH snapshots AS MATERIALIZED (
    SELECT f.* FROM public.feed_rank_snapshots f
    JOIN public.privacy_settings consent ON consent.user_id=f.viewer_id
    WHERE consent.analytics_enabled=true AND consent.ai_personalization_enabled=true
      AND f.created_at>p_as_of-interval '1 hour' AND f.expires_at>now()
      AND f.evaluation_context IS NOT NULL AND f.created_at<=p_as_of-interval '5 minutes'
      AND jsonb_array_length(f.items)<=200 AND f.experiment_revision IS NOT NULL
    ORDER BY f.created_at DESC,f.id LIMIT LEAST(50,GREATEST(1,p_limit))
  ), observed AS (
    SELECT f.id, f.viewer_id, f.created_at, f.experiment_revision, f.evaluation_context,
      entry.position, exposure.variant, exposure.served_at,
      exposure.post_id, post.user_id AS creator_id,
      COALESCE(post.id IS NOT NULL AND privacy.profile_visibility='public' AND privacy.posts_visibility='public'
        AND privacy.ai_data_sharing_enabled=true AND privacy.ai_personalization_enabled=true
        AND (post.expires_at IS NULL OR post.expires_at>now())
        AND (post.publish_at IS NULL OR post.publish_at<=now())
        AND NOT EXISTS (SELECT 1 FROM public.user_message_blocks b
          WHERE (b.blocker_user_id=f.viewer_id AND b.blocked_user_id=post.user_id)
             OR (b.blocker_user_id=post.user_id AND b.blocked_user_id=f.viewer_id)),false) AS eligible,
      ARRAY(SELECT DISTINCT i.signal_type FROM public.ml_interactions i
        WHERE i.exposure_id=exposure.id AND i.surface='feed' AND i.user_id=f.viewer_id
          AND i.post_id=exposure.post_id AND i.created_at>=exposure.served_at
          AND i.created_at<=exposure.served_at+interval '5 minutes'
          AND i.created_at<=p_as_of ORDER BY i.signal_type) AS signals
    FROM snapshots f
    CROSS JOIN LATERAL jsonb_array_elements(f.items) WITH ORDINALITY entry(item,position)
    JOIN public.feed_served_items exposure ON exposure.snapshot_id=f.id
      AND exposure.viewer_id=f.viewer_id AND exposure.post_id=(entry.item->>'id')::uuid
    LEFT JOIN public.posts post ON post.id=exposure.post_id
    LEFT JOIN public.privacy_settings privacy ON privacy.user_id=post.user_id
  ), slates AS (
    SELECT id, created_at, jsonb_build_object('slate_id',id,'user_id',viewer_id,
      'created_at',created_at,'mode',evaluation_context->>'mode',
      'author_cap',(evaluation_context->>'author_cap')::integer,
      'variant',min(variant),'revision',experiment_revision,
      'items',jsonb_agg(jsonb_build_object('post_id',post_id,'creator_id',creator_id,
        'position',position,'served_at',served_at,'signals',signals) ORDER BY position)) AS slate
    FROM observed GROUP BY id,viewer_id,created_at,experiment_revision,evaluation_context
    HAVING bool_and(eligible) AND count(*) BETWEEN 5 AND 200 AND count(DISTINCT variant)=1
      AND max(served_at)<=p_as_of-interval '5 minutes'
  )
  SELECT COALESCE(jsonb_agg(slate ORDER BY created_at,id),'[]'::jsonb) INTO result FROM slates;
  RETURN jsonb_build_object('schema',1,'source','lovable_cloud','as_of',p_as_of,
    'observation_seconds',300,'slates',result);
END;
$function$;
REVOKE ALL ON FUNCTION public.feed_evaluation_slates(integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.feed_evaluation_slates(integer,timestamptz) TO service_role;
COMMENT ON FUNCTION public.feed_evaluation_slates(integer,timestamptz) IS
  'Private paired replay export. Position-biased feedback, not causal or online A/B evidence. No model promotion.';

COMMIT;
