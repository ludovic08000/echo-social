ALTER PUBLICATION supabase_realtime ADD TABLE public.wellbeing_preferences;
ALTER TABLE public.wellbeing_preferences REPLICA IDENTITY FULL;