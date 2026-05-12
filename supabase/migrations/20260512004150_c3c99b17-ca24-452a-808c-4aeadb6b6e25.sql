
-- Samples d'entraînement
CREATE TABLE IF NOT EXISTS public.threat_training_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  features JSONB NOT NULL,
  label SMALLINT NOT NULL CHECK (label IN (0,1)),
  source TEXT NOT NULL CHECK (source IN ('regex','gemini','admin','client')),
  weight REAL NOT NULL DEFAULT 1.0,
  category TEXT,
  endpoint TEXT,
  used_in_version INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_threat_samples_created ON public.threat_training_samples(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_threat_samples_label ON public.threat_training_samples(label);

ALTER TABLE public.threat_training_samples ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read training samples" ON public.threat_training_samples
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

-- Poids du modèle (versionnés)
CREATE TABLE IF NOT EXISTS public.threat_model_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL UNIQUE,
  weights JSONB NOT NULL,
  bias REAL NOT NULL DEFAULT 0,
  accuracy REAL,
  precision_score REAL,
  recall REAL,
  f1 REAL,
  samples_used INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT false,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_threat_model_active ON public.threat_model_weights(active) WHERE active = true;

ALTER TABLE public.threat_model_weights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read model weights" ON public.threat_model_weights
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

-- Ajouter colonne decided_by sur threat_decisions pour distinguer ML vs Gemini
ALTER TABLE public.threat_decisions
  ADD COLUMN IF NOT EXISTS decided_by TEXT
    CHECK (decided_by IN ('regex','ml','gemini','hybrid','client','admin'));

-- Modèle actif (lecture publique authentifiée pour la fn edge)
CREATE OR REPLACE FUNCTION public.threat_shield_active_model()
RETURNS TABLE (version INT, weights JSONB, bias REAL, accuracy REAL, samples_used INT, trained_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT version, weights, bias, accuracy, samples_used, trained_at
  FROM public.threat_model_weights WHERE active = true
  ORDER BY trained_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.threat_shield_active_model() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.threat_shield_active_model() TO authenticated, anon, service_role;

-- Stats ML / Gemini sur 24h
CREATE OR REPLACE FUNCTION public.threat_shield_ml_stats()
RETURNS TABLE (
  decided_by_ml BIGINT,
  decided_by_gemini BIGINT,
  decided_by_regex BIGINT,
  total_samples BIGINT,
  positive_samples BIGINT,
  active_version INT,
  active_accuracy REAL,
  active_precision REAL,
  active_recall REAL
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    (SELECT COUNT(*) FROM public.threat_decisions WHERE decided_by IN ('ml','hybrid') AND created_at > now() - INTERVAL '24 hours'),
    (SELECT COUNT(*) FROM public.threat_decisions WHERE decided_by = 'gemini' AND created_at > now() - INTERVAL '24 hours'),
    (SELECT COUNT(*) FROM public.threat_decisions WHERE decided_by = 'regex' AND created_at > now() - INTERVAL '24 hours'),
    (SELECT COUNT(*) FROM public.threat_training_samples),
    (SELECT COUNT(*) FROM public.threat_training_samples WHERE label = 1),
    (SELECT version FROM public.threat_model_weights WHERE active = true ORDER BY trained_at DESC LIMIT 1),
    (SELECT accuracy FROM public.threat_model_weights WHERE active = true ORDER BY trained_at DESC LIMIT 1),
    (SELECT precision_score FROM public.threat_model_weights WHERE active = true ORDER BY trained_at DESC LIMIT 1),
    (SELECT recall FROM public.threat_model_weights WHERE active = true ORDER BY trained_at DESC LIMIT 1);
$$;
REVOKE ALL ON FUNCTION public.threat_shield_ml_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.threat_shield_ml_stats() TO authenticated;

-- Feedback admin : ajoute un sample labelé manuellement (poids x3)
CREATE OR REPLACE FUNCTION public.threat_shield_feedback(p_decision_id UUID, p_is_attack BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  d RECORD;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT * INTO d FROM public.threat_decisions WHERE id = p_decision_id;
  IF d.id IS NULL THEN RETURN; END IF;
  -- on stocke un sample minimal (les features réelles seront recalculées par la fn edge si besoin)
  INSERT INTO public.threat_training_samples (features, label, source, weight, category, endpoint)
  VALUES (
    jsonb_build_object('payload_hash', d.payload_hash, 'category', d.category, 'confidence', d.confidence, 'detector', d.detector),
    CASE WHEN p_is_attack THEN 1 ELSE 0 END,
    'admin',
    3.0,
    d.category,
    d.endpoint
  );
END $$;
REVOKE ALL ON FUNCTION public.threat_shield_feedback(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.threat_shield_feedback(UUID, BOOLEAN) TO authenticated;
