CREATE OR REPLACE FUNCTION public.ml_record_watch_time(
  p_post_id uuid,
  p_total_ms numeric,
  p_sample_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Upsert: incremental running average
  INSERT INTO ml_post_features (post_id, avg_watch_time_ms, watch_sample_count, updated_at)
  VALUES (p_post_id, p_total_ms / GREATEST(p_sample_count, 1), p_sample_count, now())
  ON CONFLICT (post_id) DO UPDATE
  SET 
    avg_watch_time_ms = (
      (COALESCE(ml_post_features.avg_watch_time_ms, 0) * COALESCE(ml_post_features.watch_sample_count, 0)
        + EXCLUDED.avg_watch_time_ms * p_sample_count)
      / NULLIF(COALESCE(ml_post_features.watch_sample_count, 0) + p_sample_count, 0)
    ),
    watch_sample_count = COALESCE(ml_post_features.watch_sample_count, 0) + p_sample_count,
    updated_at = now();
END;
$$;