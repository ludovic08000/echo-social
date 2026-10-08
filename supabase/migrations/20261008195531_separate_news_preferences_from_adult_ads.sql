BEGIN;

-- Local news is a normal authenticated feature. It must never inherit the
-- eligibility gate used for optional personalised advertising.
CREATE OR REPLACE FUNCTION public.set_news_discovery_preferences(p_preferences jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  u uuid := auth.uid();
  enabled boolean;
  selected_country text;
  selected_region text;
  selected_city text;
  saved public.discovery_preferences;
BEGIN
  IF u IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501';
  END IF;

  IF jsonb_typeof(p_preferences) IS DISTINCT FROM 'object'
    OR pg_column_size(p_preferences) > 1024
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_preferences) key
      WHERE key NOT IN ('local_media', 'country', 'region', 'city')
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_each(p_preferences) entry
      WHERE entry.key = 'local_media' AND jsonb_typeof(entry.value) <> 'boolean'
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_each(p_preferences) entry
      WHERE entry.key IN ('country', 'region', 'city')
        AND jsonb_typeof(entry.value) NOT IN ('string', 'null')
    )
  THEN
    RAISE EXCEPTION 'INVALID_PREFERENCES' USING ERRCODE='22023';
  END IF;

  enabled := coalesce((p_preferences->>'local_media')::boolean, false);
  selected_country := CASE WHEN enabled THEN nullif(upper(trim(p_preferences->>'country')), '') END;
  selected_region := CASE WHEN enabled THEN nullif(trim(p_preferences->>'region'), '') END;
  selected_city := CASE WHEN enabled THEN nullif(trim(p_preferences->>'city'), '') END;

  IF (selected_country IS NOT NULL AND selected_country !~ '^[A-Z]{2}$')
    OR length(selected_region) > 100
    OR length(selected_city) > 100
  THEN
    RAISE EXCEPTION 'INVALID_PREFERENCES' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.discovery_preferences(user_id)
  VALUES (u)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.discovery_preferences
  SET local_media = enabled,
      country = selected_country,
      region = selected_region,
      city = selected_city,
      updated_at = clock_timestamp()
  WHERE user_id = u
  RETURNING * INTO saved;

  IF to_regclass('public.ad_location_contexts') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.ad_location_contexts WHERE user_id = $1' USING u;
  END IF;
  RETURN to_jsonb(saved);
END;
$$;

REVOKE ALL ON FUNCTION public.set_news_discovery_preferences(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_news_discovery_preferences(jsonb) TO authenticated;

COMMIT;
