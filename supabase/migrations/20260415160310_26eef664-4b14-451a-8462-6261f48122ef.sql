
CREATE TABLE public.wellbeing_scores (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  score INTEGER NOT NULL DEFAULT 50,
  screen_time_score INTEGER NOT NULL DEFAULT 50,
  social_balance_score INTEGER NOT NULL DEFAULT 50,
  content_diversity_score INTEGER NOT NULL DEFAULT 50,
  break_frequency_score INTEGER NOT NULL DEFAULT 50,
  positivity_score INTEGER NOT NULL DEFAULT 50,
  factors JSONB DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.wellbeing_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own wellbeing score"
  ON public.wellbeing_scores FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own wellbeing score"
  ON public.wellbeing_scores FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own wellbeing score"
  ON public.wellbeing_scores FOR UPDATE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_wellbeing_scores_updated_at
  BEFORE UPDATE ON public.wellbeing_scores
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create wellbeing score row for new profiles
CREATE OR REPLACE FUNCTION public.handle_new_wellbeing_score()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.wellbeing_scores (user_id)
  VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_profile_created_wellbeing
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_wellbeing_score();

-- Public function to get someone's wellbeing score (privacy-safe, only score)
CREATE OR REPLACE FUNCTION public.get_public_wellbeing_score(p_user_id uuid)
  RETURNS integer
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  SELECT score FROM wellbeing_scores WHERE user_id = p_user_id;
$$;
