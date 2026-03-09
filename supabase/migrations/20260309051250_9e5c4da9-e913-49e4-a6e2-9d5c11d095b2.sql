-- A/B Tests table
CREATE TABLE public.ab_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  test_type TEXT NOT NULL DEFAULT 'feed', -- 'feed', 'moderation', 'ui'
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'running', 'paused', 'completed'
  variant_a JSONB NOT NULL DEFAULT '{}',
  variant_b JSONB NOT NULL DEFAULT '{}',
  traffic_split INTEGER NOT NULL DEFAULT 50, -- % going to variant B
  target_metric TEXT NOT NULL DEFAULT 'engagement', -- 'engagement', 'retention', 'precision', 'conversion'
  results_a JSONB DEFAULT '{"impressions": 0, "conversions": 0, "score": 0}',
  results_b JSONB DEFAULT '{"impressions": 0, "conversions": 0, "score": 0}',
  winner TEXT, -- 'a', 'b', null
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ab_tests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view ab_tests"
  ON public.ab_tests FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can manage ab_tests"
  ON public.ab_tests FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- AI Metrics Log for real-time tracking
CREATE TABLE public.ai_metrics_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id TEXT NOT NULL,
  metric_type TEXT NOT NULL DEFAULT 'call', -- 'call', 'error', 'latency', 'block', 'threat'
  value NUMERIC NOT NULL DEFAULT 1,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_metrics_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view ai_metrics_log"
  ON public.ai_metrics_log FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert ai_metrics_log"
  ON public.ai_metrics_log FOR INSERT TO authenticated
  WITH CHECK (true);

-- Index for fast time-series queries
CREATE INDEX idx_ai_metrics_log_created ON public.ai_metrics_log (created_at DESC);
CREATE INDEX idx_ai_metrics_log_module ON public.ai_metrics_log (module_id, created_at DESC);