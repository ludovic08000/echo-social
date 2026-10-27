-- Explicit feed controls: authenticated, auditable, reversible.
-- The assistant only proposes a command; these RPCs remain the authority.

ALTER TABLE public.user_feed_preferences
  ADD COLUMN IF NOT EXISTS reduced_topics text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE OR REPLACE FUNCTION public.validate_reduced_feed_topics()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  NEW.reduced_topics := ARRAY(
    SELECT DISTINCT lower(trim(topic))
    FROM unnest(COALESCE(NEW.reduced_topics, ARRAY[]::text[])) topic
    WHERE char_length(trim(topic)) BETWEEN 1 AND 40
    LIMIT 50
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_reduced_feed_topics_trigger ON public.user_feed_preferences;
CREATE TRIGGER validate_reduced_feed_topics_trigger
BEFORE INSERT OR UPDATE OF reduced_topics ON public.user_feed_preferences
FOR EACH ROW EXECUTE FUNCTION public.validate_reduced_feed_topics();

CREATE TABLE IF NOT EXISTS public.feed_preference_change_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'assistant' CHECK (source IN ('assistant', 'settings')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 180),
  command jsonb NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);

ALTER TABLE public.feed_preference_change_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own feed preference history" ON public.feed_preference_change_history;
CREATE POLICY "Users read own feed preference history"
ON public.feed_preference_change_history FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_feed_preference_history_user_created
  ON public.feed_preference_change_history(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.feed_normalize_topics(p_value jsonb, p_limit integer DEFAULT 10)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $function$
  SELECT COALESCE(array_agg(topic ORDER BY first_seen), ARRAY[]::text[])
  FROM (
    SELECT topic, min(ordinality) AS first_seen
    FROM (
      SELECT lower(trim(value)) AS topic, ordinality
      FROM jsonb_array_elements_text(COALESCE(p_value, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
    ) normalized
    WHERE char_length(topic) BETWEEN 1 AND 40
    GROUP BY topic
    ORDER BY first_seen
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
  ) limited;
$function$;

CREATE OR REPLACE FUNCTION public.apply_feed_preference_command(
  p_summary text,
  p_command jsonb
)
RETURNS TABLE(change_id uuid, applied_state jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_row public.user_feed_preferences%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_more text[];
  v_less text[];
  v_hide text[];
  v_allowed_keys text[] := ARRAY['algorithm','more_topics','less_topics','hide_topics','diversity_delta','weights'];
  v_allowed_weight_keys text[] := ARRAY['friends_delta','discovery_delta','marketplace_delta'];
  v_key text;
  v_change_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF p_command IS NULL OR jsonb_typeof(p_command) <> 'object' OR p_command = '{}'::jsonb THEN
    RAISE EXCEPTION 'INVALID_FEED_COMMAND' USING ERRCODE = '22023';
  END IF;
  IF char_length(trim(COALESCE(p_summary, ''))) NOT BETWEEN 1 AND 180 THEN
    RAISE EXCEPTION 'INVALID_FEED_SUMMARY' USING ERRCODE = '22023';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_command) LOOP
    IF NOT (v_key = ANY(v_allowed_keys)) THEN RAISE EXCEPTION 'UNKNOWN_FEED_COMMAND_KEY' USING ERRCODE = '22023'; END IF;
  END LOOP;
  IF p_command ? 'weights' THEN
    IF jsonb_typeof(p_command->'weights') <> 'object' THEN RAISE EXCEPTION 'INVALID_FEED_WEIGHTS' USING ERRCODE = '22023'; END IF;
    FOR v_key IN SELECT jsonb_object_keys(p_command->'weights') LOOP
      IF NOT (v_key = ANY(v_allowed_weight_keys)) THEN RAISE EXCEPTION 'UNKNOWN_FEED_WEIGHT_KEY' USING ERRCODE = '22023'; END IF;
    END LOOP;
  END IF;
  IF p_command ? 'more_topics' AND jsonb_typeof(p_command->'more_topics') <> 'array' THEN RAISE EXCEPTION 'INVALID_MORE_TOPICS' USING ERRCODE = '22023'; END IF;
  IF p_command ? 'less_topics' AND jsonb_typeof(p_command->'less_topics') <> 'array' THEN RAISE EXCEPTION 'INVALID_LESS_TOPICS' USING ERRCODE = '22023'; END IF;
  IF p_command ? 'hide_topics' AND jsonb_typeof(p_command->'hide_topics') <> 'array' THEN RAISE EXCEPTION 'INVALID_HIDE_TOPICS' USING ERRCODE = '22023'; END IF;
  IF p_command ? 'diversity_delta' AND jsonb_typeof(p_command->'diversity_delta') <> 'number' THEN RAISE EXCEPTION 'INVALID_DIVERSITY_DELTA' USING ERRCODE = '22023'; END IF;
  IF p_command ? 'diversity_delta' AND abs((p_command->>'diversity_delta')::integer) > 50 THEN RAISE EXCEPTION 'DIVERSITY_DELTA_OUT_OF_RANGE' USING ERRCODE = '22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(COALESCE(p_command->'weights', '{}'::jsonb)) item
    WHERE jsonb_typeof(item.value) <> 'number' OR abs((item.value #>> '{}')::integer) > 50
  ) THEN RAISE EXCEPTION 'FEED_WEIGHT_DELTA_OUT_OF_RANGE' USING ERRCODE = '22023'; END IF;
  IF p_command ? 'algorithm' AND p_command->>'algorithm' NOT IN ('smart','chronological','friends_first') THEN
    RAISE EXCEPTION 'INVALID_FEED_ALGORITHM' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_feed_preferences(user_id) VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM public.user_feed_preferences WHERE user_id = v_user_id FOR UPDATE;

  v_before := to_jsonb(v_row) - 'user_id' - 'created_at' - 'updated_at';
  v_more := public.feed_normalize_topics(p_command->'more_topics');
  v_less := public.feed_normalize_topics(p_command->'less_topics');
  v_hide := public.feed_normalize_topics(p_command->'hide_topics');

  UPDATE public.user_feed_preferences
  SET
    feed_algorithm = COALESCE(p_command->>'algorithm', feed_algorithm),
    priority_topics = ARRAY(
      SELECT DISTINCT topic FROM unnest(COALESCE(priority_topics, ARRAY[]::text[]) || v_more) topic
      WHERE NOT (topic = ANY(v_less || v_hide)) LIMIT 50
    ),
    reduced_topics = ARRAY(
      SELECT DISTINCT topic FROM unnest(COALESCE(reduced_topics, ARRAY[]::text[]) || v_less) topic
      WHERE NOT (topic = ANY(v_more || v_hide)) LIMIT 50
    ),
    muted_keywords = ARRAY(
      SELECT DISTINCT topic FROM unnest(COALESCE(muted_keywords, ARRAY[]::text[]) || v_hide) topic
      WHERE NOT (topic = ANY(v_more)) LIMIT 100
    ),
    diversity_boost = LEAST(100, GREATEST(0, diversity_boost + COALESCE((p_command->>'diversity_delta')::integer, 0))),
    weight_friends = LEAST(100, GREATEST(0, weight_friends + COALESCE((p_command->'weights'->>'friends_delta')::integer, 0))),
    weight_discovery = LEAST(100, GREATEST(0, weight_discovery + COALESCE((p_command->'weights'->>'discovery_delta')::integer, 0))),
    weight_marketplace = LEAST(100, GREATEST(0, weight_marketplace + COALESCE((p_command->'weights'->>'marketplace_delta')::integer, 0))),
    updated_at = now()
  WHERE user_id = v_user_id
  RETURNING * INTO v_row;

  v_after := to_jsonb(v_row) - 'user_id' - 'created_at' - 'updated_at';
  INSERT INTO public.feed_preference_change_history(user_id, summary, command, before_state, after_state)
  VALUES (v_user_id, trim(p_summary), p_command, v_before, v_after)
  RETURNING id INTO v_change_id;

  RETURN QUERY SELECT v_change_id, v_after;
END;
$function$;

CREATE OR REPLACE FUNCTION public.undo_feed_preference_change(p_change_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_change public.feed_preference_change_history%ROWTYPE;
  v_latest uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v_latest FROM public.feed_preference_change_history
  WHERE user_id = v_user_id AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_change_id THEN RAISE EXCEPTION 'ONLY_LATEST_CHANGE_CAN_BE_UNDONE' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_change FROM public.feed_preference_change_history
  WHERE id = p_change_id AND user_id = v_user_id AND undone_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FEED_CHANGE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.user_feed_preferences SET
    feed_algorithm = v_change.before_state->>'feed_algorithm',
    diversity_boost = (v_change.before_state->>'diversity_boost')::integer,
    muted_keywords = ARRAY(SELECT jsonb_array_elements_text(v_change.before_state->'muted_keywords')),
    priority_topics = ARRAY(SELECT jsonb_array_elements_text(v_change.before_state->'priority_topics')),
    reduced_topics = ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_change.before_state->'reduced_topics', '[]'::jsonb))),
    viral_content_reduce = (v_change.before_state->>'viral_content_reduce')::boolean,
    sensitive_content_filter = (v_change.before_state->>'sensitive_content_filter')::boolean,
    seen_posts_hide = (v_change.before_state->>'seen_posts_hide')::boolean,
    weight_friends = (v_change.before_state->>'weight_friends')::integer,
    weight_discovery = (v_change.before_state->>'weight_discovery')::integer,
    weight_marketplace = (v_change.before_state->>'weight_marketplace')::integer,
    updated_at = now()
  WHERE user_id = v_user_id;
  UPDATE public.feed_preference_change_history SET undone_at = now() WHERE id = p_change_id;
  RETURN v_change.before_state;
END;
$function$;

CREATE OR REPLACE FUNCTION public.feed_explicit_preference_scores(p_post_ids uuid[])
RETURNS TABLE(post_id uuid, score_delta numeric, hidden boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH prefs AS (
    SELECT priority_topics, reduced_topics, muted_keywords
    FROM public.user_feed_preferences WHERE user_id = auth.uid()
  ), candidates AS (
    SELECT p.id, lower(COALESCE(p.body, '')) AS body,
           ARRAY(SELECT lower(t) FROM unnest(COALESCE(f.topics, ARRAY[]::text[])) t) AS topics
    FROM public.posts p LEFT JOIN public.ml_post_features f ON f.post_id = p.id
    WHERE p.id = ANY(p_post_ids[1:250])
  )
  SELECT c.id,
    (CASE WHEN EXISTS (SELECT 1 FROM prefs x, unnest(x.priority_topics) t WHERE t = ANY(c.topics) OR position(t IN c.body) > 0) THEN 18 ELSE 0 END
     - CASE WHEN EXISTS (SELECT 1 FROM prefs x, unnest(x.reduced_topics) t WHERE t = ANY(c.topics) OR position(t IN c.body) > 0) THEN 14 ELSE 0 END)::numeric,
    EXISTS (SELECT 1 FROM prefs x, unnest(x.muted_keywords) t WHERE position(t IN c.body) > 0 OR t = ANY(c.topics))
  FROM candidates c;
$function$;

REVOKE ALL ON FUNCTION public.feed_normalize_topics(jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_feed_preference_command(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.undo_feed_preference_change(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.feed_explicit_preference_scores(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_feed_preference_command(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.undo_feed_preference_change(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feed_explicit_preference_scores(uuid[]) TO authenticated;
