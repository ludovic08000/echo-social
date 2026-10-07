BEGIN;
-- Offline work is leased and resumable. No AI request runs on the serving path.
CREATE TABLE public.feed_feature_jobs (
  post_id uuid PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','working','ready','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.feed_feature_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feed_feature_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.feed_feature_jobs TO service_role;
CREATE INDEX feed_feature_jobs_pending ON public.feed_feature_jobs(available_at,post_id)
  WHERE status IN ('pending','failed','working');

CREATE OR REPLACE FUNCTION public.enqueue_feed_features()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  INSERT INTO public.feed_feature_jobs(post_id) VALUES(NEW.id)
  ON CONFLICT(post_id) DO UPDATE SET revision=gen_random_uuid(),status='pending',attempts=0,
    lease_until=NULL,available_at=now(),updated_at=now();
  -- Never keep an old semantic vector after an edit.
  UPDATE public.ml_post_features SET embedding=NULL,embedding_text=NULL,embedding_updated_at=NULL,
    updated_at=now() WHERE post_id=NEW.id;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enqueue_feed_features() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER feed_feature_refresh AFTER INSERT OR UPDATE OF body,image_url ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_feed_features();
INSERT INTO public.feed_feature_jobs(post_id)
  SELECT id FROM public.posts WHERE expires_at IS NULL OR expires_at > now()
  ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.requeue_feed_features_on_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NEW.ai_data_sharing_enabled=true AND NEW.ai_personalization_enabled=true
    AND NEW.profile_visibility='public' AND NEW.posts_visibility='public' THEN
    INSERT INTO public.feed_feature_jobs(post_id)
      SELECT id FROM public.posts WHERE user_id=NEW.user_id AND (expires_at IS NULL OR expires_at>now())
    ON CONFLICT(post_id) DO UPDATE SET status='pending',attempts=0,revision=gen_random_uuid(),
      available_at=now(),lease_until=NULL,updated_at=now()
      WHERE public.feed_feature_jobs.status IN ('failed','skipped');
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.requeue_feed_features_on_consent() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER feed_features_consent_change AFTER UPDATE OF ai_data_sharing_enabled,ai_personalization_enabled,
  profile_visibility,posts_visibility ON public.privacy_settings
  FOR EACH ROW EXECUTE FUNCTION public.requeue_feed_features_on_consent();

CREATE OR REPLACE FUNCTION public.claim_feed_feature_jobs(p_limit integer DEFAULT 40)
RETURNS TABLE(post_id uuid, revision uuid, body text, image_url text, user_id uuid,
  created_at timestamptz, likes_count integer, comments_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT j.post_id FROM public.feed_feature_jobs j
    JOIN public.posts p ON p.id=j.post_id
    JOIN public.privacy_settings privacy ON privacy.user_id=p.user_id
    WHERE (j.status IN ('pending','failed') OR (j.status='working' AND j.lease_until < now()))
      AND j.available_at <= now() AND j.attempts < 8
      AND (p.publish_at IS NULL OR p.publish_at <= now())
      AND (p.expires_at IS NULL OR p.expires_at > now())
      AND privacy.ai_data_sharing_enabled = true AND privacy.ai_personalization_enabled = true
      AND privacy.posts_visibility='public' AND privacy.profile_visibility='public'
    ORDER BY j.available_at, j.post_id FOR UPDATE OF j SKIP LOCKED
    LIMIT LEAST(60,GREATEST(1,p_limit))
  ), claimed AS (
    UPDATE public.feed_feature_jobs j SET status='working',attempts=j.attempts+1,revision=gen_random_uuid(),
      lease_until=now()+interval '5 minutes',updated_at=now()
    FROM candidates c WHERE j.post_id=c.post_id RETURNING j.post_id,j.revision
  )
  SELECT p.id,c.revision,p.body,p.image_url,p.user_id,p.created_at,p.likes_count,p.comments_count
    FROM claimed c JOIN public.posts p ON p.id=c.post_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_feed_feature_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_feed_feature_jobs(integer) TO service_role;

CREATE TABLE public.feed_training_leases (
  name text PRIMARY KEY, owner uuid NOT NULL, expires_at timestamptz NOT NULL
);
ALTER TABLE public.feed_training_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feed_training_leases FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.feed_training_leases TO service_role;
CREATE OR REPLACE FUNCTION public.claim_feed_training_lease(p_name text,p_owner uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE claimed text;
BEGIN
  IF p_name NOT IN ('features','two_tower') THEN RETURN false; END IF;
  INSERT INTO public.feed_training_leases(name,owner,expires_at)
    VALUES(p_name,p_owner,now()+interval '5 minutes')
    ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
      WHERE public.feed_training_leases.expires_at < now()
    RETURNING name INTO claimed;
  RETURN claimed IS NOT NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_feed_training_lease(text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_feed_training_lease(text,uuid) TO service_role;

-- Candidate artifacts are private and cannot become live through a training call.
-- Promotion requires a separate reviewed release after offline and online gates.
CREATE TABLE public.feed_model_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind='two_tower'),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('candidate','rejected')),
  metrics jsonb NOT NULL,
  artifacts jsonb NOT NULL,
  CHECK (jsonb_typeof(artifacts)='object')
);
ALTER TABLE public.feed_model_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feed_model_candidates FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.feed_model_candidates TO service_role;
CREATE OR REPLACE FUNCTION public.finish_feed_feature_job(p_post uuid,p_revision uuid,p_features jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  job public.feed_feature_jobs%ROWTYPE;
  semantic_vector public.ml_post_features.embedding%TYPE;
BEGIN
  SELECT * INTO job FROM public.feed_feature_jobs j WHERE j.post_id=p_post FOR UPDATE;
  IF NOT FOUND OR job.revision<>p_revision OR job.status<>'working' OR job.lease_until < now() THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.posts p JOIN public.privacy_settings s ON s.user_id=p.user_id
    WHERE p.id=p_post AND s.ai_data_sharing_enabled=true AND s.ai_personalization_enabled=true
      AND s.posts_visibility='public' AND s.profile_visibility='public'
      AND (p.expires_at IS NULL OR p.expires_at > now())
      AND (p.publish_at IS NULL OR p.publish_at <= now())) THEN
    UPDATE public.feed_feature_jobs SET status='skipped',lease_until=NULL WHERE post_id=p_post;
    RETURN false;
  END IF;
  IF p_features IS NULL THEN
    UPDATE public.feed_feature_jobs SET status='failed',lease_until=NULL,
      available_at=now()+make_interval(mins=>LEAST(1440,power(2,job.attempts)::integer)),updated_at=now()
      WHERE post_id=p_post;
    RETURN false;
  END IF;
  semantic_vector := p_features->>'embedding';
  INSERT INTO public.ml_post_features(post_id,topics,hashtags,sentiment,quality_score,language,has_media,creator_id,
    embedding,embedding_text,embedding_source,embedding_updated_at,updated_at)
  SELECT p.id,ARRAY(SELECT jsonb_array_elements_text(p_features->'topics')),
    ARRAY(SELECT jsonb_array_elements_text(p_features->'hashtags')),
    (p_features->>'sentiment')::numeric,(p_features->>'quality')::numeric,p_features->>'language',
    p.image_url IS NOT NULL,p.user_id,semantic_vector,
    p_features->>'embedding_text',p_features->>'embedding_source',now(),now()
    FROM public.posts p WHERE p.id=p_post
  ON CONFLICT(post_id) DO UPDATE SET topics=EXCLUDED.topics,hashtags=EXCLUDED.hashtags,
    sentiment=EXCLUDED.sentiment,quality_score=EXCLUDED.quality_score,language=EXCLUDED.language,
    has_media=EXCLUDED.has_media,creator_id=EXCLUDED.creator_id,embedding=EXCLUDED.embedding,
    embedding_text=EXCLUDED.embedding_text,embedding_source=EXCLUDED.embedding_source,
    embedding_updated_at=EXCLUDED.embedding_updated_at,updated_at=now();
  UPDATE public.feed_feature_jobs SET status=CASE WHEN p_features->>'embedding' IS NULL THEN 'skipped' ELSE 'ready' END,
    lease_until=NULL,updated_at=now() WHERE post_id=p_post;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.finish_feed_feature_job(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_feed_feature_job(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.feed_training_events(p_limit integer DEFAULT 10000,p_as_of timestamptz DEFAULT now())
RETURNS SETOF public.ml_interactions LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT i.* FROM public.ml_interactions i
  JOIN public.privacy_settings s ON s.user_id=i.user_id
  WHERE s.analytics_enabled=true AND s.ai_personalization_enabled=true AND i.surface='feed'
    AND i.created_at > p_as_of-interval '14 days' AND i.created_at <= p_as_of
  ORDER BY i.created_at DESC,i.id DESC LIMIT LEAST(10000,GREATEST(1,p_limit));
$function$;
REVOKE ALL ON FUNCTION public.feed_training_events(integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.feed_training_events(integer,timestamptz) TO service_role;

-- Offline comparison must include the actual preference/diversity ordering,
-- not just the scorer output. The private preview never issues exposures.
CREATE OR REPLACE FUNCTION public.preview_feed_training_order(p_user_id uuid,p_limit integer DEFAULT 40)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE preview_id uuid; ordered_items jsonb; result jsonb;
BEGIN
  IF p_user_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.final_score DESC,r.created_at DESC,r.id),'[]'::jsonb)
    INTO ordered_items FROM public.get_feed_posts_v8(p_user_id,200,0) r;
  INSERT INTO public.feed_rank_snapshots(viewer_id,items) VALUES(p_user_id,ordered_items)
    RETURNING id,items INTO preview_id,ordered_items;
  SELECT COALESCE(jsonb_agg(item ORDER BY position),'[]'::jsonb) INTO result
    FROM jsonb_array_elements(ordered_items) WITH ORDINALITY e(item,position)
    WHERE position<=LEAST(100,GREATEST(1,p_limit));
  DELETE FROM public.feed_rank_snapshots WHERE id=preview_id;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.preview_feed_training_order(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preview_feed_training_order(uuid,integer) TO service_role;

-- Same vector space on both sides of cosine; privacy opt-out also applies at serving time.
CREATE OR REPLACE FUNCTION public.feed_score_batch(
  p_user_id uuid,
  p_post_ids uuid[],
  p_algo text DEFAULT 'smart'
)
RETURNS TABLE(
  post_id uuid,
  final_score numeric,
  ml_score numeric,
  classic_score numeric,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_algo text;
  v_now timestamptz := now();
  v_paris_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night boolean := false;
  v_personalized boolean := false;
BEGIN
  IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF array_length(p_post_ids, 1) > 250 THEN
    p_post_ids := p_post_ids[1:250];
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.privacy_settings p WHERE p.user_id=v_user_id AND p.ai_personalization_enabled=true) INTO v_personalized;

  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  SELECT feed_algorithm INTO v_algo
  FROM public.user_feed_preferences
  WHERE user_id = v_user_id;

  v_algo := COALESCE(v_algo, p_algo, 'smart');
  IF v_algo NOT IN ('smart', 'chronological', 'friends_first') THEN
    v_algo := 'smart';
  END IF;

  RETURN QUERY
  WITH friends AS (
    SELECT CASE WHEN requester_id = v_user_id THEN addressee_id ELSE requester_id END AS friend_id
    FROM public.friendships
    WHERE v_user_id IS NOT NULL
      AND status = 'accepted'
      AND (requester_id = v_user_id OR addressee_id = v_user_id)
  ),
  interests AS (
    SELECT lower(interest_value) AS tag, COALESCE(weight, 1)::numeric AS weight
    FROM public.user_interests
    WHERE user_id = v_user_id AND v_personalized
    ORDER BY weight DESC NULLS LAST
    LIMIT 40
  ),
  user_recent_neg AS (
    SELECT mi.post_id, COUNT(*)::numeric AS neg_count
    FROM public.ml_interactions mi
    WHERE mi.user_id = v_user_id
      AND mi.created_at > v_now - interval '30 days'
      AND mi.signal_type IN ('hide', 'not_interested', 'report')
    GROUP BY mi.post_id
  ),
  author_recent AS (
    SELECT p.user_id AS author_id,
      COUNT(*) FILTER (WHERE mi.signal_type IN ('dwell_medium','dwell_long','watch_complete','like','comment','share','save'))::numeric AS pos_count,
      COUNT(*) FILTER (WHERE mi.signal_type IN ('skip_fast','hide','not_interested','report'))::numeric AS neg_count
    FROM public.ml_interactions mi
    JOIN public.posts p ON p.id = mi.post_id
    WHERE mi.user_id = v_user_id AND v_personalized
      AND mi.created_at > v_now - interval '48 hours'
    GROUP BY p.user_id
  ),
  ml AS (
    SELECT m.post_id, COALESCE(m.score, 0.5)::numeric AS ml_score
    FROM public.ml_pareto_score_batch(v_user_id, p_post_ids) m
  ),
  base AS (
    SELECT
      p.id AS post_id,
      p.user_id AS author_id,
      p.body,
      p.image_url,
      p.created_at,
      COALESCE(p.likes_count, 0)::numeric AS likes_count,
      COALESCE(p.comments_count, 0)::numeric AS comments_count,
      GREATEST(0.05, EXTRACT(EPOCH FROM (v_now - p.created_at)) / 3600.0)::numeric AS age_h,
      COALESCE(f.quality_score, 0.5)::numeric AS feature_quality,
      COALESCE(f.avg_watch_time_ms, 0)::numeric AS avg_watch_time_ms,
      COALESCE(f.watch_sample_count, 0)::numeric AS watch_sample_count,
      COALESCE(f.positive_count, 0)::numeric AS positive_count,
      COALESCE(f.negative_count, 0)::numeric AS negative_count,
      COALESCE(f.wellbeing_score, 0.5)::numeric AS wellbeing_score
    FROM public.posts p
    LEFT JOIN public.ml_post_features f ON f.post_id = p.id
    WHERE p.id = ANY(p_post_ids)
      AND (p.expires_at IS NULL OR p.expires_at > v_now)
  ),
  scored AS (
    SELECT
      b.*,
      COALESCE(m.ml_score, 0.5)::numeric AS ml_score,
      1.0 * POWER(0.5, b.age_h / 10.0) AS freshness,
      LEAST(1.0, LN(1 + (b.likes_count + b.comments_count * 2.5) / GREATEST(b.age_h, 0.5)) / LN(18)) AS velocity,
      LEAST(1.0, LN(1 + b.likes_count + b.comments_count * 2.0) / LN(120)) AS engagement,
      CASE
        WHEN b.author_id = v_user_id THEN CASE WHEN b.age_h < 2 THEN 1.0 ELSE 0.45 END
        WHEN EXISTS (SELECT 1 FROM friends WHERE friend_id = b.author_id) THEN CASE WHEN v_algo = 'friends_first' THEN 1.0 ELSE 0.60 END
        ELSE 0.15
      END AS social,
      LEAST(1.0,
        b.feature_quality * 0.55
        + LEAST(1.0, b.avg_watch_time_ms / 12000.0) * 0.25
        + b.wellbeing_score * 0.20
      ) AS quality,
      LEAST(1.0, COALESCE((
        SELECT SUM(i.weight) / 12.0
        FROM interests i
        WHERE position(i.tag IN lower(COALESCE(b.body, ''))) > 0
      ), 0)) AS interest,
      CASE
        WHEN b.age_h < 12 AND (b.likes_count + b.comments_count + b.watch_sample_count) < 8 THEN 0.10
        ELSE 0
      END AS cold_start,
      LEAST(0.22, COALESCE(ar.pos_count, 0) * 0.015 + COALESCE(ar.neg_count, 0) * 0.06) AS author_fatigue,
      LEAST(1.0, COALESCE(urn.neg_count, 0) / 2.0) AS user_post_negative,
      (get_byte(decode(substr(md5(COALESCE(v_user_id::text, 'guest') || ':' || b.post_id::text || ':' || date_trunc('day', v_now)::text), 1, 2), 'hex'), 0)::numeric / 255.0) AS stable_explore
    FROM base b
    LEFT JOIN ml m ON m.post_id = b.post_id
    LEFT JOIN author_recent ar ON ar.author_id = b.author_id
    LEFT JOIN user_recent_neg urn ON urn.post_id = b.post_id
  ),
  final AS (
    SELECT
      s.post_id,
      s.ml_score,
      LEAST(100, GREATEST(0,
        s.freshness * 22
        + s.velocity * 16
        + s.engagement * 12
        + s.social * 14
        + s.quality * 14
        + s.interest * 10
        + s.cold_start * 100
      ))::numeric AS classic_score,
      CASE
        WHEN v_algo = 'chronological' THEN EXTRACT(EPOCH FROM s.created_at)::numeric
        ELSE LEAST(100, GREATEST(0,
          (
            s.ml_score * 52
            + s.freshness * 16
            + s.velocity * 10
            + s.social * 8
            + s.quality * 7
            + s.interest * 5
            + s.stable_explore * 2
            + s.cold_start * 100
          )
          - s.author_fatigue * 100
          - s.user_post_negative * 100
          - CASE WHEN v_late_night THEN s.velocity * 8 ELSE 0 END
        ))::numeric
      END AS final_score,
      CASE
        WHEN s.user_post_negative > 0 THEN 'blocked_negative_feedback'
        WHEN s.cold_start > 0 THEN 'cold_start_exploration'
        WHEN s.interest > 0.25 THEN 'interest_match'
        WHEN s.social > 0.5 THEN 'social_affinity'
        ELSE 'personalized_v7'
      END AS reason
    FROM scored s
  )
  SELECT f.post_id, f.final_score, f.ml_score, f.classic_score, f.reason
  FROM final f;
END;
$function$;

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

  IF NOT EXISTS (SELECT 1 FROM public.privacy_settings p WHERE p.user_id=v_user_id AND p.ai_personalization_enabled=true) THEN
    v_user_emb_768 := NULL; v_user_emb_256 := NULL; v_interests := ARRAY[]::text[];
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
      AND embedding.embedding_source = 'two_tower'
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

  IF NOT EXISTS (SELECT 1 FROM public.privacy_settings p WHERE p.user_id=v_user_id AND p.ai_personalization_enabled=true) THEN
    v_user_emb_256 := NULL; v_profile := NULL;
  END IF;

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
            AND COALESCE(v_profile.avg_session_dwell_ms, 0) > 0
          THEN (
            LEAST(
              1.0,
              feature.avg_watch_time_ms / GREATEST(v_profile.avg_session_dwell_ms, 1000)
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
        ON post_embedding.post_id = input.post_id AND post_embedding.embedding_source = 'two_tower'
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
      -- A degraded scorer must not re-enter legacy personalization that ignores consent.
      v_score := 0.5;
      post_id := v_post_id;
      score := COALESCE(v_score, 0.5);
      RETURN NEXT;
    END LOOP;
  END;
END;
$function$;


CREATE OR REPLACE FUNCTION public.rollback_feed_legacy_config(p_change_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  change public.feed_config_change_log%ROWTYPE;
  current_value jsonb;
BEGIN
  SELECT * INTO change FROM public.feed_config_change_log WHERE id=p_change_id FOR UPDATE;
  IF NOT FOUND OR change.rolled_back THEN RAISE EXCEPTION 'change unavailable'; END IF;
  SELECT value INTO current_value FROM public.feed_algorithm_config WHERE key=change.config_key FOR UPDATE;
  IF current_value IS DISTINCT FROM change.new_value THEN RAISE EXCEPTION 'configuration changed since this edit'; END IF;
  IF change.old_value IS NULL THEN
    DELETE FROM public.feed_algorithm_config WHERE key=change.config_key;
  ELSE
    UPDATE public.feed_algorithm_config SET value=change.old_value,updated_at=now() WHERE key=change.config_key;
  END IF;
  UPDATE public.feed_config_change_log SET rolled_back=true,rolled_back_at=now() WHERE id=p_change_id;
  RETURN jsonb_build_object('status','ok','rolled_back',change.config_key,'restored_value',change.old_value);
END;
$function$;
REVOKE ALL ON FUNCTION public.rollback_feed_legacy_config(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_feed_legacy_config(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.feed_ml_health()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'admin required' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object(
    'coverage',(SELECT to_jsonb(c) FROM public.ml_feed_coverage_snapshots c ORDER BY c.captured_at DESC LIMIT 1),
    'mmr',(SELECT to_jsonb(m) FROM public.ml_feed_mmr_shadow_runs m ORDER BY m.started_at DESC LIMIT 1),
    'queue',(SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*) n FROM public.feed_feature_jobs GROUP BY status) q),
    'candidate',(SELECT jsonb_build_object('id',c.id,'status',c.status,'created_at',c.created_at,'metrics',c.metrics)
      FROM public.feed_model_candidates c ORDER BY c.created_at DESC LIMIT 1),
    'experiments',(SELECT jsonb_agg(to_jsonb(e)) FROM (
      SELECT metadata->>'experiment_revision' AS revision,variant,
        count(*) FILTER(WHERE event_type='view') AS views,
        count(DISTINCT user_id) FILTER(WHERE event_type='view') AS viewers,
        count(*) FILTER(WHERE event_type='click') AS clicks
      FROM public.ml_feed_experiment_events WHERE created_at > now()-interval '7 days'
        AND metadata->>'provenance'='served'
      GROUP BY metadata->>'experiment_revision',variant
    ) e),
    'promotion_enabled',false);
END;
$function$;
REVOKE ALL ON FUNCTION public.feed_ml_health() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.feed_ml_health() TO authenticated;

COMMIT;
