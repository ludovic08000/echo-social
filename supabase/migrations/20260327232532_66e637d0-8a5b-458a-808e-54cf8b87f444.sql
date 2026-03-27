
CREATE TABLE public.zeus_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  source_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT zeus_memory_importance_check CHECK (importance >= 1 AND importance <= 10)
);

CREATE INDEX idx_zeus_memory_user ON public.zeus_memory(user_id);
CREATE INDEX idx_zeus_memory_category ON public.zeus_memory(user_id, category);

ALTER TABLE public.zeus_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own memories"
  ON public.zeus_memory FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access on zeus_memory"
  ON public.zeus_memory FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
