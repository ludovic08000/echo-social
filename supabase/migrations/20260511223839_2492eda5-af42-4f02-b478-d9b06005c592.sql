
CREATE TABLE IF NOT EXISTS public.ai_engine_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('zeus','ai-engine')),
  action text,
  user_id uuid,
  latency_ms integer NOT NULL DEFAULT 0,
  success boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_engine_events_module_created_idx ON public.ai_engine_events (module_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_engine_events_created_idx ON public.ai_engine_events (created_at DESC);

ALTER TABLE public.ai_engine_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read ai_engine_events"
  ON public.ai_engine_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

ALTER TABLE public.ai_engine_events REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_engine_events;

CREATE OR REPLACE FUNCTION public.ai_engine_module_stats(p_window_minutes integer DEFAULT 1440)
RETURNS TABLE (
  module_id text,
  total_calls bigint,
  avg_latency_ms numeric,
  success_rate numeric,
  last_used timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.module_id,
    COUNT(*)::bigint AS total_calls,
    ROUND(AVG(e.latency_ms)::numeric, 0) AS avg_latency_ms,
    ROUND((SUM(CASE WHEN e.success THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0)) * 100, 1) AS success_rate,
    MAX(e.created_at) AS last_used
  FROM public.ai_engine_events e
  WHERE e.created_at > now() - (p_window_minutes || ' minutes')::interval
    AND public.has_role(auth.uid(), 'admin')
  GROUP BY e.module_id;
$$;

CREATE OR REPLACE FUNCTION public.purge_old_ai_engine_events()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.ai_engine_events WHERE created_at < now() - interval '7 days';
$$;
