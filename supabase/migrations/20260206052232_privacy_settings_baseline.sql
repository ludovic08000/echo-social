-- Baseline reconstruite de public.privacy_settings.
-- Invariant corrige : la table existait en production sans CREATE TABLE dans
-- l'historique, ce qui rendait tout `supabase db reset` impossible.
-- Definition alignee sur le schema reel observe en production (colonnes 1..13).
CREATE TABLE IF NOT EXISTS public.privacy_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE,
  profile_visibility text NOT NULL DEFAULT 'public' CHECK (profile_visibility = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text])),
  posts_visibility text NOT NULL DEFAULT 'public' CHECK (posts_visibility = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text])),
  comments_allowed text NOT NULL DEFAULT 'everyone' CHECK (comments_allowed = ANY (ARRAY['everyone'::text, 'friends'::text, 'nobody'::text])),
  likes_visibility text NOT NULL DEFAULT 'public' CHECK (likes_visibility = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text])),
  messages_allowed text NOT NULL DEFAULT 'everyone' CHECK (messages_allowed = ANY (ARRAY['everyone'::text, 'friends'::text, 'nobody'::text])),
  friends_list_visibility text NOT NULL DEFAULT 'friends' CHECK (friends_list_visibility = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text])),
  online_status_visibility text NOT NULL DEFAULT 'friends' CHECK (online_status_visibility = ANY (ARRAY['everyone'::text, 'friends'::text, 'nobody'::text])),
  search_engine_indexing boolean NOT NULL DEFAULT false,
  analytics_enabled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.privacy_settings TO authenticated;
GRANT ALL ON public.privacy_settings TO service_role;

ALTER TABLE public.privacy_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'privacy_settings' AND policyname = 'Users can view their own privacy settings') THEN
    CREATE POLICY "Users can view their own privacy settings"
      ON public.privacy_settings FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'privacy_settings' AND policyname = 'Users can insert their own privacy settings') THEN
    CREATE POLICY "Users can insert their own privacy settings"
      ON public.privacy_settings FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'privacy_settings' AND policyname = 'Users can update their own privacy settings') THEN
    CREATE POLICY "Users can update their own privacy settings"
      ON public.privacy_settings FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_privacy_settings_updated_at ON public.privacy_settings;
CREATE TRIGGER update_privacy_settings_updated_at
  BEFORE UPDATE ON public.privacy_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
