
-- ML Models registry
CREATE TABLE public.ml_models (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0',
  domain TEXT NOT NULL, -- 'fraud', 'moderation', 'feed', 'matching'
  description TEXT,
  config JSONB DEFAULT '{}',
  accuracy NUMERIC(5,4),
  precision_score NUMERIC(5,4),
  recall_score NUMERIC(5,4),
  f1_score NUMERIC(5,4),
  total_predictions INTEGER DEFAULT 0,
  total_correct INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, version)
);

ALTER TABLE public.ml_models ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read active models" ON public.ml_models FOR SELECT USING (is_active = true);

-- ML Predictions log
CREATE TABLE public.ml_predictions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  model_id UUID REFERENCES public.ml_models(id) ON DELETE SET NULL,
  domain TEXT NOT NULL,
  user_id UUID,
  target_id TEXT, -- post_id, user_id, etc.
  target_type TEXT, -- 'post', 'user', 'message', 'friendship'
  prediction JSONB NOT NULL, -- {label, scores, features_used}
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
  is_correct BOOLEAN, -- filled later via feedback
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ml_predictions_domain ON public.ml_predictions(domain, created_at DESC);
CREATE INDEX idx_ml_predictions_user ON public.ml_predictions(user_id, domain);
CREATE INDEX idx_ml_predictions_target ON public.ml_predictions(target_id, target_type);

ALTER TABLE public.ml_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own predictions" ON public.ml_predictions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service can insert predictions" ON public.ml_predictions FOR INSERT WITH CHECK (true);

-- Fraud detection signals
CREATE TABLE public.ml_fraud_signals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  signal_type TEXT NOT NULL, -- 'velocity_anomaly', 'device_mismatch', 'geo_impossible', 'behavior_bot', 'content_spam'
  risk_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  details JSONB DEFAULT '{}',
  resolved BOOLEAN DEFAULT false,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fraud_signals_user ON public.ml_fraud_signals(user_id, created_at DESC);
CREATE INDEX idx_fraud_signals_unresolved ON public.ml_fraud_signals(resolved, risk_score DESC);

ALTER TABLE public.ml_fraud_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own fraud signals" ON public.ml_fraud_signals FOR SELECT USING (auth.uid() = user_id);

-- Training feedback loop
CREATE TABLE public.ml_training_feedback (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  prediction_id UUID REFERENCES public.ml_predictions(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  original_label TEXT,
  corrected_label TEXT NOT NULL,
  feedback_source TEXT DEFAULT 'human', -- 'human', 'auto', 'admin'
  reviewer_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_training_feedback_domain ON public.ml_training_feedback(domain, created_at DESC);

ALTER TABLE public.ml_training_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Reviewers see own feedback" ON public.ml_training_feedback FOR SELECT USING (auth.uid() = reviewer_id);
CREATE POLICY "Auth users can submit feedback" ON public.ml_training_feedback FOR INSERT WITH CHECK (auth.uid() = reviewer_id);

-- Triggers for updated_at
CREATE TRIGGER update_ml_models_updated_at BEFORE UPDATE ON public.ml_models
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed default models
INSERT INTO public.ml_models (name, version, domain, description, config) VALUES
  ('forsure-fraud-v1', '1.0', 'fraud', 'Détection de comptes frauduleux par analyse comportementale', '{"features": ["login_velocity", "device_diversity", "geo_jumps", "content_patterns", "social_graph"]}'),
  ('forsure-moderation-v1', '1.0', 'moderation', 'Modération de contenu auto-apprenante', '{"features": ["toxicity", "spam_score", "nsfw_probability", "context_analysis"]}'),
  ('forsure-feed-v1', '1.0', 'feed', 'Recommandation de feed personnalisé', '{"features": ["engagement_history", "interest_similarity", "recency", "social_proximity", "content_diversity"]}'),
  ('forsure-matching-v1', '1.0', 'matching', 'Matching d''amis intelligent', '{"features": ["interest_overlap", "behavior_similarity", "geo_proximity", "mutual_friends", "activity_compatibility"]}');
