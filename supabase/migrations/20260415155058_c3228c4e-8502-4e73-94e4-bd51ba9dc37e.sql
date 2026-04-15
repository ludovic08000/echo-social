-- Table for ML behavior signals
CREATE TABLE public.user_behavior_signals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  post_id UUID NOT NULL,
  signal_type TEXT NOT NULL,
  value NUMERIC DEFAULT 1,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for fast ML queries
CREATE INDEX idx_behavior_user_time ON public.user_behavior_signals (user_id, created_at DESC);
CREATE INDEX idx_behavior_post ON public.user_behavior_signals (post_id);
CREATE INDEX idx_behavior_type ON public.user_behavior_signals (signal_type, created_at DESC);

-- RLS
ALTER TABLE public.user_behavior_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own signals"
ON public.user_behavior_signals FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own signals"
ON public.user_behavior_signals FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Cleanup function for old signals (>90 days)
CREATE OR REPLACE FUNCTION public.cleanup_old_behavior_signals()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.user_behavior_signals WHERE created_at < now() - interval '90 days';
END;
$$;