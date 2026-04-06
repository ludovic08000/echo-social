
-- Table for storing feed learning insights (trends, patterns, moderation improvements)
CREATE TABLE public.feed_learning_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_type TEXT NOT NULL DEFAULT 'trend',
  category TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  description TEXT,
  data JSONB DEFAULT '{}',
  confidence NUMERIC DEFAULT 0,
  is_applied BOOLEAN DEFAULT false,
  applied_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table for user interest profiles learned from their posts
CREATE TABLE public.user_learned_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  interests JSONB DEFAULT '[]',
  sentiment_average NUMERIC DEFAULT 0,
  posting_patterns JSONB DEFAULT '{}',
  content_style TEXT,
  top_topics TEXT[] DEFAULT '{}',
  engagement_score NUMERIC DEFAULT 0,
  last_analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- Table for feed learning job runs
CREATE TABLE public.feed_learning_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL DEFAULT 'full',
  posts_analyzed INTEGER DEFAULT 0,
  users_profiled INTEGER DEFAULT 0,
  trends_detected INTEGER DEFAULT 0,
  moderation_rules_created INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  error_message TEXT,
  summary JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- RLS
ALTER TABLE public.feed_learning_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_learned_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_learning_runs ENABLE ROW LEVEL SECURITY;

-- Admins can read all learning data
CREATE POLICY "Admins can read feed_learning_insights" ON public.feed_learning_insights
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can read user_learned_profiles" ON public.user_learned_profiles
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can read own learned profile" ON public.user_learned_profiles
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "Admins can read feed_learning_runs" ON public.feed_learning_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
