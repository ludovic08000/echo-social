
-- Feed performance metrics (Level 1: Observer)
CREATE TABLE public.feed_performance_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  metric_type TEXT NOT NULL, -- 'load_time', 'scroll_depth', 'posts_rendered', 'engagement_rate', 'abandonment', 'fps'
  value NUMERIC NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient querying
CREATE INDEX idx_feed_perf_metrics_type_time ON public.feed_performance_metrics (metric_type, created_at DESC);
CREATE INDEX idx_feed_perf_metrics_session ON public.feed_performance_metrics (session_id);

-- Feed config change log (audit trail + rollback)
CREATE TABLE public.feed_config_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  change_source TEXT NOT NULL DEFAULT 'manual', -- 'manual', 'ai_recommendation', 'ai_auto'
  ai_level TEXT, -- 'observer', 'recommender', 'autonomous'
  reason TEXT,
  applied_by TEXT, -- 'admin', 'zeus', 'system'
  rolled_back BOOLEAN NOT NULL DEFAULT false,
  rolled_back_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feed_config_log_key ON public.feed_config_change_log (config_key, created_at DESC);

-- AI feed recommendations (Level 2: Recommender)
CREATE TABLE public.feed_ai_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_type TEXT NOT NULL, -- 'score_adjustment', 'pagination', 'cache', 'performance', 'content_insight'
  severity TEXT NOT NULL DEFAULT 'info', -- 'info', 'warning', 'critical'
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggested_action JSONB, -- { key, current_value, suggested_value }
  auto_applicable BOOLEAN NOT NULL DEFAULT false,
  safe_bounds JSONB, -- { min, max } for autonomous mode
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'applied', 'dismissed', 'expired'
  applied_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feed_ai_reco_status ON public.feed_ai_recommendations (status, created_at DESC);

-- RLS: only admins can read/write these tables
ALTER TABLE public.feed_performance_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_config_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_ai_recommendations ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can insert metrics (their own data)
CREATE POLICY "Users can insert own metrics" ON public.feed_performance_metrics
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Only admins can read metrics
CREATE POLICY "Admins can read metrics" ON public.feed_performance_metrics
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Only admins can manage config log and recommendations
CREATE POLICY "Admins manage config log" ON public.feed_config_change_log
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins manage recommendations" ON public.feed_ai_recommendations
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Service role can insert recommendations (from edge functions)
CREATE POLICY "Service can insert recommendations" ON public.feed_ai_recommendations
  FOR INSERT TO authenticated
  WITH CHECK (true);
