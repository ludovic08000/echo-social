-- Create friend groups table
CREATE TABLE public.friend_groups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#D4AF37', -- Gold default
  icon TEXT DEFAULT 'users',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create junction table for friends in groups
CREATE TABLE public.friend_group_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES public.friend_groups(id) ON DELETE CASCADE,
  friend_user_id UUID NOT NULL,
  added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(group_id, friend_user_id)
);

-- Create notification settings table
CREATE TABLE public.notification_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  likes_enabled BOOLEAN NOT NULL DEFAULT true,
  comments_enabled BOOLEAN NOT NULL DEFAULT true,
  friend_requests_enabled BOOLEAN NOT NULL DEFAULT true,
  messages_enabled BOOLEAN NOT NULL DEFAULT true,
  story_views_enabled BOOLEAN NOT NULL DEFAULT true,
  close_friends_posts_enabled BOOLEAN NOT NULL DEFAULT true,
  email_notifications_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all new tables
ALTER TABLE public.friend_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;

-- Friend groups policies
CREATE POLICY "Users can view their own friend groups"
ON public.friend_groups FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own friend groups"
ON public.friend_groups FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own friend groups"
ON public.friend_groups FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own friend groups"
ON public.friend_groups FOR DELETE
USING (auth.uid() = user_id);

-- Friend group members policies
CREATE POLICY "Users can view members of their groups"
ON public.friend_group_members FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.friend_groups 
  WHERE id = group_id AND user_id = auth.uid()
));

CREATE POLICY "Users can add members to their groups"
ON public.friend_group_members FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.friend_groups 
  WHERE id = group_id AND user_id = auth.uid()
));

CREATE POLICY "Users can remove members from their groups"
ON public.friend_group_members FOR DELETE
USING (EXISTS (
  SELECT 1 FROM public.friend_groups 
  WHERE id = group_id AND user_id = auth.uid()
));

-- Notification settings policies
CREATE POLICY "Users can view their own notification settings"
ON public.notification_settings FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own notification settings"
ON public.notification_settings FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own notification settings"
ON public.notification_settings FOR UPDATE
USING (auth.uid() = user_id);

-- Triggers for updated_at
CREATE TRIGGER update_friend_groups_updated_at
BEFORE UPDATE ON public.friend_groups
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_notification_settings_updated_at
BEFORE UPDATE ON public.notification_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();