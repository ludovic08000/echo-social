CREATE OR REPLACE FUNCTION public.live_score_batch(p_user_id uuid, p_limit integer)
 RETURNS TABLE(live_id uuid, score numeric, engagement_score numeric, freshness_score numeric, wellbeing_score numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_limit int := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
  v_paris_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night boolean := false;
  v_following_ids uuid[] := '{}';
  v_interests text[] := '{}';
  v_muted text[] := '{}';
  v_recent_authors uuid[] := '{}';
BEGIN
  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  IF v_user_id IS NOT NULL THEN
    SELECT COALESCE(array_agg(DISTINCT CASE WHEN requester_id = v_user_id THEN addressee_id ELSE requester_id END), '{}')
    INTO v_following_ids FROM public.friendships
    WHERE status = 'accepted' AND (requester_id = v_user_id OR addressee_id = v_user_id);

    -- Sujets prioritaires explicites + intérêts appris, normalisés (minuscules, sans #).
    SELECT COALESCE(array_agg(DISTINCT t), '{}') INTO v_interests FROM (
      SELECT lower(trim(both '#' from btrim(x))) t
      FROM public.user_feed_preferences fp, unnest(COALESCE(fp.priority_topics, '{}')) x
      WHERE fp.user_id = v_user_id
      UNION
      SELECT lower(trim(both '#' from btrim(interest_value))) FROM (
        SELECT interest_value FROM public.user_interests WHERE user_id = v_user_id
        ORDER BY weight DESC NULLS LAST LIMIT 40) i
    ) s WHERE length(t) >= 2;

    SELECT COALESCE(array_agg(lower(btrim(m))) FILTER (WHERE length(btrim(m)) >= 2), '{}') INTO v_muted
    FROM public.user_feed_preferences fp, unnest(COALESCE(fp.muted_keywords, '{}')) m
    WHERE fp.user_id = v_user_id;

    SELECT COALESCE(array_agg(ls.user_id), '{}') INTO v_recent_authors FROM (
      SELECT lv.live_id FROM public.live_views lv
      WHERE lv.user_id = v_user_id AND lv.joined_at > now() - interval '24 hours'
      ORDER BY lv.joined_at DESC LIMIT 25) recent
    JOIN public.live_streams ls ON ls.id = recent.live_id;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT ls.id, ls.user_id,
      ARRAY(SELECT lower(trim(both '#' from btrim(h))) FROM unnest(COALESCE(ls.hashtags, '{}') || ARRAY[COALESCE(ls.category, '')]) h WHERE btrim(h) <> '') AS tags,
      lower(COALESCE(ls.title, '') || ' ' || COALESCE(ls.description, '')) AS txt,
      COALESCE(ls.viewer_count, 0)::numeric AS viewer_count,
      COALESCE(ls.peak_viewer_count, 0)::numeric AS peak_viewer_count,
      COALESCE(ls.total_views, 0)::numeric AS total_views,
      GREATEST(0.05, EXTRACT(EPOCH FROM (now() - COALESCE(ls.started_at, ls.created_at))) / 3600.0)::numeric AS age_h,
      COALESCE((SELECT COUNT(*)::numeric FROM public.live_views lv
        WHERE lv.live_id = ls.id AND lv.joined_at > now() - interval '2 minutes'), 0) AS recent_joins
    FROM public.live_streams ls
    WHERE ls.is_active = true
  ),
  scored AS (
    SELECT b.id AS live_id,
      (b.user_id = ANY(v_following_ids)) AS followed,
      LEAST(1.0, (b.viewer_count * 0.55 + b.peak_viewer_count * 0.20 + b.recent_joins * 8 + b.total_views * 0.01) / 350.0) AS eng,
      POWER(0.5, b.age_h / 2.5) AS fresh,
      -- Mots-clés du live (hashtags, catégorie, titre) comparés aux sujets de l'utilisateur.
      CASE WHEN array_length(v_interests, 1) IS NULL THEN 0 ELSE LEAST(1.0, (
        SELECT COUNT(*)::numeric FROM unnest(v_interests) i
        WHERE EXISTS (SELECT 1 FROM unnest(b.tags) t WHERE t = i OR t LIKE i || '%' OR i LIKE t || '%')
           OR b.txt LIKE '%' || i || '%'
      ) / 2.0) END AS interest,
      EXISTS (SELECT 1 FROM unnest(v_muted) m WHERE b.txt LIKE '%' || m || '%' OR m = ANY(b.tags)) AS muted,
      CASE WHEN array_length(v_recent_authors, 1) IS NULL THEN 0
        ELSE LEAST(0.20, (SELECT COUNT(*)::numeric FROM unnest(v_recent_authors) a WHERE a = b.user_id) * 0.065) END AS author_fatigue,
      (get_byte(decode(substr(md5(COALESCE(v_user_id::text, 'guest') || ':' || b.id::text || ':' || date_trunc('hour', now())::text), 1, 2), 'hex'), 0)::numeric / 255.0) AS explore
    FROM base b
  ),
  final AS (
    SELECT s.*, LEAST(1.0, GREATEST(0,
        s.eng * 0.30 + s.fresh * 0.20 + s.interest * 0.40 + s.explore * 0.04
        - s.author_fatigue - CASE WHEN v_late_night THEN s.eng * 0.13 ELSE 0 END
        - CASE WHEN s.muted THEN 0.5 ELSE 0 END)) AS base_score
    FROM scored s
  )
  SELECT f.live_id,
    -- Les créateurs suivis passent toujours devant les préférences : palier +1.
    (CASE WHEN f.followed AND NOT f.muted THEN 1.0 ELSE 0 END + f.base_score)::numeric AS score,
    f.eng, f.fresh,
    CASE WHEN v_late_night THEN GREATEST(0, 1.0 - f.eng * 0.5) ELSE 1.0 END::numeric
  FROM final f
  ORDER BY score DESC
  LIMIT v_limit;
END;
$function$;