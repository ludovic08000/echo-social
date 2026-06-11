CREATE TABLE IF NOT EXISTS public.wellbeing_preferences (
  user_id uuid PRIMARY KEY,
  daily_limit_minutes integer NOT NULL DEFAULT 60,
  focus_mode_enabled boolean NOT NULL DEFAULT false,
  bedtime_reminder_enabled boolean NOT NULL DEFAULT false,
  bedtime_hour integer NOT NULL DEFAULT 23,
  scroll_pause_enabled boolean NOT NULL DEFAULT true,
  scroll_pause_minutes integer NOT NULL DEFAULT 15,
  hide_like_counts boolean NOT NULL DEFAULT false,
  grayscale_after_limit boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wellbeing_preferences TO authenticated;
GRANT ALL ON public.wellbeing_preferences TO service_role;

ALTER TABLE public.wellbeing_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wellbeing_prefs_select_own"
ON public.wellbeing_preferences FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "wellbeing_prefs_insert_own"
ON public.wellbeing_preferences FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "wellbeing_prefs_update_own"
ON public.wellbeing_preferences FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "wellbeing_prefs_delete_own"
ON public.wellbeing_preferences FOR DELETE
TO authenticated
USING (user_id = auth.uid());

CREATE TRIGGER update_wellbeing_preferences_updated_at
BEFORE UPDATE ON public.wellbeing_preferences
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();