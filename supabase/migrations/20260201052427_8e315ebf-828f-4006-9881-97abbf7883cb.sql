-- Table pour les vidéos courtes (Reels/TikTok style)
CREATE TABLE public.short_videos (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  caption TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  hashtags TEXT[] DEFAULT '{}',
  sound_id UUID,
  sound_name TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  share_count INTEGER NOT NULL DEFAULT 0,
  is_public BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour les lives
CREATE TABLE public.live_streams (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  stream_key TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  viewer_count INTEGER NOT NULL DEFAULT 0,
  peak_viewer_count INTEGER NOT NULL DEFAULT 0,
  total_views INTEGER NOT NULL DEFAULT 0,
  category TEXT DEFAULT 'general',
  hashtags TEXT[] DEFAULT '{}',
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour suivre les vues de vidéos (temps de visionnage crucial pour l'algo)
CREATE TABLE public.video_views (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  video_id UUID NOT NULL REFERENCES public.short_videos(id) ON DELETE CASCADE,
  watch_time_seconds INTEGER NOT NULL DEFAULT 0,
  completion_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  replayed BOOLEAN NOT NULL DEFAULT false,
  source TEXT DEFAULT 'feed', -- feed, profile, search, shared
  viewed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour les likes de vidéos
CREATE TABLE public.video_likes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  video_id UUID NOT NULL REFERENCES public.short_videos(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, video_id)
);

-- Table pour les commentaires de vidéos
CREATE TABLE public.video_comments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  video_id UUID NOT NULL REFERENCES public.short_videos(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  parent_id UUID REFERENCES public.video_comments(id) ON DELETE CASCADE,
  like_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour les sauvegardes de vidéos
CREATE TABLE public.video_saves (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  video_id UUID NOT NULL REFERENCES public.short_videos(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, video_id)
);

-- Table pour les partages de vidéos
CREATE TABLE public.video_shares (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  video_id UUID NOT NULL REFERENCES public.short_videos(id) ON DELETE CASCADE,
  share_type TEXT DEFAULT 'copy_link', -- copy_link, message, external
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour les intérêts utilisateur (catégories/tags suivis)
CREATE TABLE public.user_interests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  interest_type TEXT NOT NULL, -- hashtag, category, creator
  interest_value TEXT NOT NULL,
  weight DECIMAL(5,2) NOT NULL DEFAULT 1.0, -- Poids de l'intérêt (calculé par l'algo)
  explicit BOOLEAN NOT NULL DEFAULT false, -- true si l'utilisateur l'a déclaré, false si inféré
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, interest_type, interest_value)
);

-- Table pour les vues de lives
CREATE TABLE public.live_views (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  live_id UUID NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  watch_time_seconds INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  left_at TIMESTAMP WITH TIME ZONE
);

-- Table pour les messages de chat live
CREATE TABLE public.live_chat (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  live_id UUID NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  is_gift BOOLEAN NOT NULL DEFAULT false,
  gift_type TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Activer RLS sur toutes les tables
ALTER TABLE public.short_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_chat ENABLE ROW LEVEL SECURITY;

-- Policies pour short_videos
CREATE POLICY "Videos are viewable by everyone" ON public.short_videos FOR SELECT USING (is_public = true OR user_id = auth.uid());
CREATE POLICY "Users can create videos" ON public.short_videos FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their videos" ON public.short_videos FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their videos" ON public.short_videos FOR DELETE USING (auth.uid() = user_id);

-- Policies pour live_streams
CREATE POLICY "Lives are viewable by everyone" ON public.live_streams FOR SELECT USING (true);
CREATE POLICY "Users can create lives" ON public.live_streams FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their lives" ON public.live_streams FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their lives" ON public.live_streams FOR DELETE USING (auth.uid() = user_id);

-- Policies pour video_views
CREATE POLICY "Users can view their own views" ON public.video_views FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create views" ON public.video_views FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their views" ON public.video_views FOR UPDATE USING (auth.uid() = user_id);

-- Policies pour video_likes
CREATE POLICY "Likes are viewable" ON public.video_likes FOR SELECT USING (true);
CREATE POLICY "Users can like videos" ON public.video_likes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can unlike videos" ON public.video_likes FOR DELETE USING (auth.uid() = user_id);

-- Policies pour video_comments
CREATE POLICY "Comments are viewable" ON public.video_comments FOR SELECT USING (true);
CREATE POLICY "Users can comment" ON public.video_comments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their comments" ON public.video_comments FOR DELETE USING (auth.uid() = user_id);

-- Policies pour video_saves
CREATE POLICY "Users can view their saves" ON public.video_saves FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can save videos" ON public.video_saves FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can unsave videos" ON public.video_saves FOR DELETE USING (auth.uid() = user_id);

-- Policies pour video_shares
CREATE POLICY "Users can view their shares" ON public.video_shares FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can share videos" ON public.video_shares FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Policies pour user_interests
CREATE POLICY "Users can view their interests" ON public.user_interests FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create interests" ON public.user_interests FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their interests" ON public.user_interests FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their interests" ON public.user_interests FOR DELETE USING (auth.uid() = user_id);

-- Policies pour live_views
CREATE POLICY "Users can view their live views" ON public.live_views FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create live views" ON public.live_views FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their live views" ON public.live_views FOR UPDATE USING (auth.uid() = user_id);

-- Policies pour live_chat
CREATE POLICY "Live chat is viewable" ON public.live_chat FOR SELECT USING (true);
CREATE POLICY "Users can send chat messages" ON public.live_chat FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their chat messages" ON public.live_chat FOR DELETE USING (auth.uid() = user_id);

-- Activer realtime pour le chat live
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_chat;
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_streams;

-- Créer les index pour performance de l'algorithme
CREATE INDEX idx_short_videos_user ON public.short_videos(user_id);
CREATE INDEX idx_short_videos_created ON public.short_videos(created_at DESC);
CREATE INDEX idx_short_videos_hashtags ON public.short_videos USING GIN(hashtags);
CREATE INDEX idx_video_views_user ON public.video_views(user_id);
CREATE INDEX idx_video_views_video ON public.video_views(video_id);
CREATE INDEX idx_video_likes_video ON public.video_likes(video_id);
CREATE INDEX idx_user_interests_user ON public.user_interests(user_id);
CREATE INDEX idx_live_streams_active ON public.live_streams(is_active) WHERE is_active = true;

-- Trigger pour mettre à jour updated_at
CREATE TRIGGER update_short_videos_updated_at BEFORE UPDATE ON public.short_videos FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_user_interests_updated_at BEFORE UPDATE ON public.user_interests FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Créer bucket pour les vidéos
INSERT INTO storage.buckets (id, name, public) VALUES ('videos', 'videos', true) ON CONFLICT DO NOTHING;

-- Policies pour le bucket videos
CREATE POLICY "Videos are publicly accessible" ON storage.objects FOR SELECT USING (bucket_id = 'videos');
CREATE POLICY "Users can upload videos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'videos' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can update their videos" ON storage.objects FOR UPDATE USING (bucket_id = 'videos' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can delete their videos" ON storage.objects FOR DELETE USING (bucket_id = 'videos' AND auth.uid()::text = (storage.foldername(name))[1]);