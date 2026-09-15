-- Historique restauré depuis Lovable Cloud : schema_migrations, version 20260201040412.
-- Rétablit les tables de confidentialité avant les migrations qui les modifient.
-- Table pour les paramètres de confidentialité granulaires
CREATE TABLE public.privacy_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  -- Visibilité du profil
  profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public', 'friends', 'private')),
  -- Qui peut voir les posts
  posts_visibility TEXT NOT NULL DEFAULT 'public' CHECK (posts_visibility IN ('public', 'friends', 'private')),
  -- Qui peut commenter
  comments_allowed TEXT NOT NULL DEFAULT 'everyone' CHECK (comments_allowed IN ('everyone', 'friends', 'nobody')),
  -- Qui peut voir les likes
  likes_visibility TEXT NOT NULL DEFAULT 'public' CHECK (likes_visibility IN ('public', 'friends', 'private')),
  -- Qui peut envoyer des messages
  messages_allowed TEXT NOT NULL DEFAULT 'everyone' CHECK (messages_allowed IN ('everyone', 'friends', 'nobody')),
  -- Qui peut voir la liste d'amis
  friends_list_visibility TEXT NOT NULL DEFAULT 'friends' CHECK (friends_list_visibility IN ('public', 'friends', 'private')),
  -- Qui peut voir le statut en ligne
  online_status_visibility TEXT NOT NULL DEFAULT 'friends' CHECK (online_status_visibility IN ('everyone', 'friends', 'nobody')),
  -- Indexation par moteurs de recherche
  search_engine_indexing BOOLEAN NOT NULL DEFAULT false,
  -- Collecte de données analytiques
  analytics_enabled BOOLEAN NOT NULL DEFAULT false,
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour les demandes d'export de données (RGPD - droit à la portabilité)
CREATE TABLE public.data_export_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'expired')),
  download_url TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Table pour les demandes de suppression de compte (RGPD - droit à l'oubli)
CREATE TABLE public.account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  confirmation_token UUID DEFAULT gen_random_uuid(),
  scheduled_deletion_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.privacy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;

-- RLS Policies for privacy_settings
CREATE POLICY "Users can view their own privacy settings"
  ON public.privacy_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own privacy settings"
  ON public.privacy_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own privacy settings"
  ON public.privacy_settings FOR UPDATE
  USING (auth.uid() = user_id);

-- RLS Policies for data_export_requests
CREATE POLICY "Users can view their own export requests"
  ON public.data_export_requests FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own export requests"
  ON public.data_export_requests FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for account_deletion_requests
CREATE POLICY "Users can view their own deletion requests"
  ON public.account_deletion_requests FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own deletion requests"
  ON public.account_deletion_requests FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own deletion requests"
  ON public.account_deletion_requests FOR UPDATE
  USING (auth.uid() = user_id);

-- Trigger pour updated_at sur privacy_settings
CREATE TRIGGER update_privacy_settings_updated_at
  BEFORE UPDATE ON public.privacy_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Créer automatiquement les paramètres de confidentialité lors de la création du profil
CREATE OR REPLACE FUNCTION public.handle_new_privacy_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.privacy_settings (user_id)
  VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_profile_created_add_privacy_settings
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_privacy_settings();
