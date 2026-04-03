
-- Security incidents table: stores each detected attack/event
CREATE TABLE public.security_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type TEXT NOT NULL DEFAULT 'unknown',
  severity TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'detected',
  source_ip TEXT,
  target_endpoint TEXT,
  attack_vector TEXT,
  success BOOLEAN NOT NULL DEFAULT false,
  vulnerability_found TEXT,
  ai_analysis TEXT,
  ai_recommendation TEXT,
  raw_data JSONB DEFAULT '{}',
  alert_sent BOOLEAN NOT NULL DEFAULT false,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI learned security patterns for self-learning
CREATE TABLE public.security_ai_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name TEXT NOT NULL,
  pattern_signature JSONB NOT NULL DEFAULT '{}',
  detection_rule TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  confidence REAL NOT NULL DEFAULT 0.5,
  times_matched INTEGER NOT NULL DEFAULT 0,
  last_matched_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  source TEXT NOT NULL DEFAULT 'ai_learned',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alert config
CREATE TABLE public.security_alert_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_email TEXT NOT NULL,
  min_severity TEXT NOT NULL DEFAULT 'medium',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert default alert config
INSERT INTO public.security_alert_config (alert_email, min_severity, is_active)
VALUES ('ludovic43@msn.com', 'medium', true);

-- Enable RLS
ALTER TABLE public.security_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_ai_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_alert_config ENABLE ROW LEVEL SECURITY;

-- Admin-only policies
CREATE POLICY "Admins can manage security_incidents" ON public.security_incidents
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage security_ai_patterns" ON public.security_ai_patterns
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage security_alert_config" ON public.security_alert_config
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Service role needs full access for edge functions
CREATE POLICY "Service role full access incidents" ON public.security_incidents
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access patterns" ON public.security_ai_patterns
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access alert_config" ON public.security_alert_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Index for fast queries
CREATE INDEX idx_security_incidents_created ON public.security_incidents (created_at DESC);
CREATE INDEX idx_security_incidents_severity ON public.security_incidents (severity, status);
CREATE INDEX idx_security_ai_patterns_active ON public.security_ai_patterns (is_active, confidence DESC);
