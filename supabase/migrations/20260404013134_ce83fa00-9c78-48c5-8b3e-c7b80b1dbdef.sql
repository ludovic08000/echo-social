
-- Table for tracking AI security quality metrics
CREATE TABLE public.security_quality_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id TEXT NOT NULL,
  total_incidents INTEGER DEFAULT 0,
  local_detections INTEGER DEFAULT 0,
  ai_detections INTEGER DEFAULT 0,
  false_positives INTEGER DEFAULT 0,
  false_negatives INTEGER DEFAULT 0,
  confirmed_threats INTEGER DEFAULT 0,
  reaction_time_ms INTEGER DEFAULT 0,
  ai_cost_saved BOOLEAN DEFAULT false,
  autonomy_level INTEGER DEFAULT 1,
  autonomy_score NUMERIC(5,4) DEFAULT 0,
  detection_rate NUMERIC(5,4) DEFAULT 0,
  patterns_used INTEGER DEFAULT 0,
  patterns_learned INTEGER DEFAULT 0,
  gemini_calls INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for time-series queries
CREATE INDEX idx_security_quality_metrics_created ON public.security_quality_metrics(created_at DESC);

-- RLS
ALTER TABLE public.security_quality_metrics ENABLE ROW LEVEL SECURITY;

-- Only admins can read (via has_role)
CREATE POLICY "Admins can view security quality metrics"
  ON public.security_quality_metrics FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Add autonomy_level column to security_ai_patterns for progressive autonomy
ALTER TABLE public.security_ai_patterns
  ADD COLUMN IF NOT EXISTS autonomy_level INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS false_positive_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confirmed_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_reaction_ms INTEGER DEFAULT 0;

-- Add structured threat classification to security_incidents
ALTER TABLE public.security_incidents
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(5,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence_factors JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS autonomy_level INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS detection_source TEXT DEFAULT 'heuristic',
  ADD COLUMN IF NOT EXISTS human_verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS was_false_positive BOOLEAN DEFAULT false;
