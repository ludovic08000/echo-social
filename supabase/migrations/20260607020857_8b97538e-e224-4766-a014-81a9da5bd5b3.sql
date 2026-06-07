
-- ============================================
-- QUALITY EVENTS — Mesure qualité prod
-- ============================================

CREATE TABLE IF NOT EXISTS public.quality_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  session_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('video','post','live')),
  content_id UUID NOT NULL,
  author_id UUID,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'watch_time','completion','skip_fast','rewatch','share','save','return_session','ios_perf','view'
  )),
  value NUMERIC NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_ios BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qe_created ON public.quality_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qe_content ON public.quality_events (content_id, surface, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qe_author ON public.quality_events (author_id, created_at DESC) WHERE author_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qe_event_type ON public.quality_events (event_type, created_at DESC);

GRANT SELECT, INSERT ON public.quality_events TO authenticated;
GRANT SELECT ON public.quality_events TO anon;
GRANT ALL ON public.quality_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.quality_events_id_seq TO authenticated, anon, service_role;

ALTER TABLE public.quality_events ENABLE ROW LEVEL SECURITY;

-- INSERT: tout utilisateur authentifié peut logger, anon aussi (telemetry)
CREATE POLICY "qe_insert_anyone" ON public.quality_events
  FOR INSERT TO authenticated, anon
  WITH CHECK (true);

-- SELECT: admin voit tout, créateur voit ses propres contenus
CREATE POLICY "qe_select_admin_or_author" ON public.quality_events
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR author_id = auth.uid()
  );

-- ============================================
-- RPC d'agrégation pour le dashboard
-- ============================================
CREATE OR REPLACE FUNCTION public.quality_metrics_summary(
  p_surface TEXT DEFAULT NULL,
  p_since TIMESTAMPTZ DEFAULT (now() - INTERVAL '7 days'),
  p_author_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN := false;
  v_filter_author UUID;
  v_result JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Auth required';
  END IF;

  v_is_admin := public.has_role(v_uid, 'admin'::app_role);

  -- Non-admin: forcé à ses propres contenus
  IF v_is_admin THEN
    v_filter_author := p_author_id;
  ELSE
    v_filter_author := v_uid;
  END IF;

  SELECT jsonb_build_object(
    'total_views', COUNT(*) FILTER (WHERE event_type = 'view'),
    'avg_watch_ms', COALESCE(AVG(value) FILTER (WHERE event_type = 'watch_time'), 0)::int,
    'total_watch_ms', COALESCE(SUM(value) FILTER (WHERE event_type = 'watch_time'), 0)::bigint,
    'avg_completion_pct', COALESCE(AVG(value) FILTER (WHERE event_type = 'completion'), 0)::numeric(5,2),
    'skip_fast_count', COUNT(*) FILTER (WHERE event_type = 'skip_fast'),
    'rewatch_count', COUNT(*) FILTER (WHERE event_type = 'rewatch'),
    'share_count', COUNT(*) FILTER (WHERE event_type = 'share'),
    'save_count', COUNT(*) FILTER (WHERE event_type = 'save'),
    'return_sessions', COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'return_session'),
    'unique_viewers', COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'view' AND user_id IS NOT NULL),
    'ios_share_pct', CASE WHEN COUNT(*) FILTER (WHERE event_type = 'view') > 0
      THEN (COUNT(*) FILTER (WHERE event_type = 'view' AND is_ios) * 100.0
           / COUNT(*) FILTER (WHERE event_type = 'view'))::numeric(5,2)
      ELSE 0 END,
    'ios_avg_perf_ms', COALESCE(AVG(value) FILTER (WHERE event_type = 'ios_perf'), 0)::int
  )
  INTO v_result
  FROM public.quality_events
  WHERE created_at >= p_since
    AND (p_surface IS NULL OR surface = p_surface)
    AND (v_filter_author IS NULL OR author_id = v_filter_author);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.quality_metrics_summary(TEXT, TIMESTAMPTZ, UUID) TO authenticated;

-- Série temporelle (par heure ou jour)
CREATE OR REPLACE FUNCTION public.quality_metrics_timeline(
  p_surface TEXT DEFAULT NULL,
  p_since TIMESTAMPTZ DEFAULT (now() - INTERVAL '7 days'),
  p_bucket TEXT DEFAULT 'hour',
  p_author_id UUID DEFAULT NULL
)
RETURNS TABLE(bucket TIMESTAMPTZ, views BIGINT, avg_completion NUMERIC, avg_watch_ms NUMERIC, skip_fast BIGINT, ios_perf_ms NUMERIC)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_filter_author UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Auth required'; END IF;
  v_is_admin := public.has_role(v_uid, 'admin'::app_role);
  v_filter_author := CASE WHEN v_is_admin THEN p_author_id ELSE v_uid END;

  RETURN QUERY
  SELECT
    date_trunc(p_bucket, qe.created_at) AS bucket,
    COUNT(*) FILTER (WHERE qe.event_type = 'view')::bigint,
    COALESCE(AVG(qe.value) FILTER (WHERE qe.event_type = 'completion'), 0)::numeric(5,2),
    COALESCE(AVG(qe.value) FILTER (WHERE qe.event_type = 'watch_time'), 0)::numeric(12,2),
    COUNT(*) FILTER (WHERE qe.event_type = 'skip_fast')::bigint,
    COALESCE(AVG(qe.value) FILTER (WHERE qe.event_type = 'ios_perf'), 0)::numeric(12,2)
  FROM public.quality_events qe
  WHERE qe.created_at >= p_since
    AND (p_surface IS NULL OR qe.surface = p_surface)
    AND (v_filter_author IS NULL OR qe.author_id = v_filter_author)
  GROUP BY 1
  ORDER BY 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.quality_metrics_timeline(TEXT, TIMESTAMPTZ, TEXT, UUID) TO authenticated;
