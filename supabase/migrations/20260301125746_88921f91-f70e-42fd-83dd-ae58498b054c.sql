
-- Table pour stocker les feedbacks d'apprentissage IA
CREATE TABLE public.ai_feedback (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  original_text TEXT NOT NULL,
  ai_decision TEXT NOT NULL,
  human_decision TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour les règles auto-apprises par l'IA
CREATE TABLE public.ai_learned_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rule TEXT NOT NULL,
  source_feedback_id UUID REFERENCES public.ai_feedback(id) ON DELETE SET NULL,
  pattern TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour le cache de modération côté serveur
CREATE TABLE public.ai_moderation_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  result JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '1 hour')
);

-- Index pour la performance
CREATE INDEX idx_ai_feedback_user ON public.ai_feedback(user_id);
CREATE INDEX idx_ai_moderation_cache_hash ON public.ai_moderation_cache(content_hash);
CREATE INDEX idx_ai_moderation_cache_expires ON public.ai_moderation_cache(expires_at);

-- RLS
ALTER TABLE public.ai_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_learned_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_moderation_cache ENABLE ROW LEVEL SECURITY;

-- Policies: feedback visible par son auteur
CREATE POLICY "Users can read own feedback" ON public.ai_feedback FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert feedback" ON public.ai_feedback FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Learned rules: lisibles par tous les authentifiés (partagées)
CREATE POLICY "Authenticated users can read rules" ON public.ai_learned_rules FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "System can insert rules" ON public.ai_learned_rules FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Cache: accessible par tous les authentifiés
CREATE POLICY "Authenticated users can read cache" ON public.ai_moderation_cache FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert cache" ON public.ai_moderation_cache FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Fonction de nettoyage du cache expiré
CREATE OR REPLACE FUNCTION public.cleanup_ai_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.ai_moderation_cache WHERE expires_at < now();
END;
$$;
