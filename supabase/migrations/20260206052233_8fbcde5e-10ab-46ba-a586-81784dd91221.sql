
-- =============================================
-- PHASE 1: Humeur du jour (mood on profiles)
-- =============================================
ALTER TABLE public.profiles ADD COLUMN mood_emoji text DEFAULT NULL;
ALTER TABLE public.profiles ADD COLUMN mood_text text DEFAULT NULL;
ALTER TABLE public.profiles ADD COLUMN mood_updated_at timestamp with time zone DEFAULT NULL;

-- =============================================
-- PHASE 2: Playlist d'ambiance (profile music)
-- =============================================
ALTER TABLE public.profiles ADD COLUMN profile_music_url text DEFAULT NULL;

-- =============================================
-- PHASE 3: Mode Fantôme + Détox digitale
-- =============================================
ALTER TABLE public.privacy_settings ADD COLUMN ghost_mode boolean NOT NULL DEFAULT false;
ALTER TABLE public.privacy_settings ADD COLUMN detox_schedule jsonb DEFAULT NULL;
ALTER TABLE public.privacy_settings ADD COLUMN daily_limit_minutes integer DEFAULT NULL;

-- =============================================
-- PHASE 4: Posts éphémères + Capsule temporelle
-- =============================================
ALTER TABLE public.posts ADD COLUMN expires_at timestamp with time zone DEFAULT NULL;
ALTER TABLE public.posts ADD COLUMN publish_at timestamp with time zone DEFAULT NULL;

-- =============================================
-- PHASE 5: Journal intime privé
-- =============================================
CREATE TABLE public.journal_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  title text,
  body text NOT NULL,
  mood text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own journal entries"
  ON public.journal_entries FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own journal entries"
  ON public.journal_entries FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own journal entries"
  ON public.journal_entries FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own journal entries"
  ON public.journal_entries FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_journal_entries_updated_at
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- PHASE 6: Mur anonyme
-- =============================================
CREATE TABLE public.anonymous_wall_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  target_user_id uuid NOT NULL,
  author_id uuid NOT NULL,
  message text NOT NULL,
  is_approved boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.anonymous_wall_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view approved wall messages on any profile"
  ON public.anonymous_wall_messages FOR SELECT
  USING (is_approved = true OR auth.uid() = target_user_id);

CREATE POLICY "Authenticated users can post on walls"
  ON public.anonymous_wall_messages FOR INSERT
  WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Target users can moderate their wall"
  ON public.anonymous_wall_messages FOR UPDATE
  USING (auth.uid() = target_user_id);

CREATE POLICY "Target users can delete wall messages"
  ON public.anonymous_wall_messages FOR DELETE
  USING (auth.uid() = target_user_id);

-- =============================================
-- PHASE 7: Défis entre amis
-- =============================================
CREATE TABLE public.challenges (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  challenge_type text NOT NULL DEFAULT 'photo',
  image_url text,
  starts_at timestamp with time zone NOT NULL DEFAULT now(),
  ends_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Challenges are viewable by everyone"
  ON public.challenges FOR SELECT USING (true);

CREATE POLICY "Users can create challenges"
  ON public.challenges FOR INSERT
  WITH CHECK (auth.uid() = creator_id);

CREATE POLICY "Users can update their challenges"
  ON public.challenges FOR UPDATE
  USING (auth.uid() = creator_id);

CREATE POLICY "Users can delete their challenges"
  ON public.challenges FOR DELETE
  USING (auth.uid() = creator_id);

CREATE TABLE public.challenge_participants (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(challenge_id, user_id)
);

ALTER TABLE public.challenge_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants are viewable by everyone"
  ON public.challenge_participants FOR SELECT USING (true);

CREATE POLICY "Users can join challenges"
  ON public.challenge_participants FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can leave challenges"
  ON public.challenge_participants FOR DELETE
  USING (auth.uid() = user_id);

CREATE TABLE public.challenge_submissions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  content text,
  image_url text,
  votes integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.challenge_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Submissions are viewable by everyone"
  ON public.challenge_submissions FOR SELECT USING (true);

CREATE POLICY "Participants can create submissions"
  ON public.challenge_submissions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their submissions"
  ON public.challenge_submissions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their submissions"
  ON public.challenge_submissions FOR DELETE
  USING (auth.uid() = user_id);
