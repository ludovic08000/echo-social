-- Historique restauré depuis Lovable Cloud : schema_migrations, version 20260201044728.
-- =====================
-- GROUPES (style Facebook)
-- =====================

-- Table des groupes
CREATE TABLE public.groups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cover_image_url TEXT,
  privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private', 'secret')),
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Membres des groupes
CREATE TABLE public.group_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member')),
  joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- Posts dans les groupes
CREATE TABLE public.group_posts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- =====================
-- PAGES (style Facebook)
-- =====================

-- Table des pages
CREATE TABLE public.pages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT,
  cover_image_url TEXT,
  profile_image_url TEXT,
  website_url TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Administrateurs des pages
CREATE TABLE public.page_admins (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'editor', 'moderator')),
  added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(page_id, user_id)
);

-- Abonnés des pages
CREATE TABLE public.page_followers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  followed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(page_id, user_id)
);

-- Posts des pages
CREATE TABLE public.page_posts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- =====================
-- RLS POLICIES - GROUPES
-- =====================

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_posts ENABLE ROW LEVEL SECURITY;

-- Groupes: visibles selon leur confidentialité
CREATE POLICY "Public groups are viewable by everyone" 
ON public.groups FOR SELECT 
USING (privacy = 'public' OR privacy = 'private' OR 
  EXISTS (SELECT 1 FROM public.group_members WHERE group_id = id AND user_id = auth.uid()));

CREATE POLICY "Authenticated users can create groups" 
ON public.groups FOR INSERT 
WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Group admins can update groups" 
ON public.groups FOR UPDATE 
USING (EXISTS (SELECT 1 FROM public.group_members WHERE group_id = id AND user_id = auth.uid() AND role = 'admin'));

CREATE POLICY "Group admins can delete groups" 
ON public.groups FOR DELETE 
USING (created_by = auth.uid());

-- Group Members
CREATE POLICY "Users can view group members" 
ON public.group_members FOR SELECT 
USING (true);

CREATE POLICY "Users can join groups" 
ON public.group_members FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can leave groups" 
ON public.group_members FOR DELETE 
USING (auth.uid() = user_id OR 
  EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = group_id AND gm.user_id = auth.uid() AND gm.role = 'admin'));

CREATE POLICY "Admins can update member roles" 
ON public.group_members FOR UPDATE 
USING (EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = group_id AND gm.user_id = auth.uid() AND gm.role = 'admin'));

-- Group Posts
CREATE POLICY "Group posts are viewable by members" 
ON public.group_posts FOR SELECT 
USING (EXISTS (SELECT 1 FROM public.group_members WHERE group_id = group_posts.group_id AND user_id = auth.uid()) OR
  EXISTS (SELECT 1 FROM public.groups WHERE id = group_id AND privacy = 'public'));

CREATE POLICY "Members can create group posts" 
ON public.group_posts FOR INSERT 
WITH CHECK (EXISTS (SELECT 1 FROM public.group_members WHERE group_id = group_posts.group_id AND user_id = auth.uid()));

CREATE POLICY "Users can delete their group posts" 
ON public.group_posts FOR DELETE 
USING (auth.uid() = user_id);

-- =====================
-- RLS POLICIES - PAGES
-- =====================

ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_posts ENABLE ROW LEVEL SECURITY;

-- Pages: visibles par tous
CREATE POLICY "Pages are viewable by everyone" 
ON public.pages FOR SELECT 
USING (true);

CREATE POLICY "Authenticated users can create pages" 
ON public.pages FOR INSERT 
WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Page admins can update pages" 
ON public.pages FOR UPDATE 
USING (EXISTS (SELECT 1 FROM public.page_admins WHERE page_id = id AND user_id = auth.uid() AND role = 'admin'));

CREATE POLICY "Page creator can delete pages" 
ON public.pages FOR DELETE 
USING (created_by = auth.uid());

-- Page Admins
CREATE POLICY "Page admins are viewable" 
ON public.page_admins FOR SELECT 
USING (true);

CREATE POLICY "Page admins can add other admins" 
ON public.page_admins FOR INSERT 
WITH CHECK (EXISTS (SELECT 1 FROM public.page_admins WHERE page_id = page_admins.page_id AND user_id = auth.uid() AND role = 'admin') OR
  EXISTS (SELECT 1 FROM public.pages WHERE id = page_id AND created_by = auth.uid()));

CREATE POLICY "Page admins can remove admins" 
ON public.page_admins FOR DELETE 
USING (EXISTS (SELECT 1 FROM public.page_admins pa WHERE pa.page_id = page_id AND pa.user_id = auth.uid() AND pa.role = 'admin'));

-- Page Followers
CREATE POLICY "Followers are viewable" 
ON public.page_followers FOR SELECT 
USING (true);

CREATE POLICY "Users can follow pages" 
ON public.page_followers FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can unfollow pages" 
ON public.page_followers FOR DELETE 
USING (auth.uid() = user_id);

-- Page Posts
CREATE POLICY "Page posts are viewable by everyone" 
ON public.page_posts FOR SELECT 
USING (true);

CREATE POLICY "Page admins can create posts" 
ON public.page_posts FOR INSERT 
WITH CHECK (EXISTS (SELECT 1 FROM public.page_admins WHERE page_id = page_posts.page_id AND user_id = auth.uid()));

CREATE POLICY "Users can delete their page posts" 
ON public.page_posts FOR DELETE 
USING (auth.uid() = user_id);

-- =====================
-- TRIGGERS
-- =====================

CREATE TRIGGER update_groups_updated_at
BEFORE UPDATE ON public.groups
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pages_updated_at
BEFORE UPDATE ON public.pages
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-add creator as admin when creating a group
CREATE OR REPLACE FUNCTION public.handle_new_group()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'admin');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_group_created
AFTER INSERT ON public.groups
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_group();

-- Auto-add creator as admin when creating a page
CREATE OR REPLACE FUNCTION public.handle_new_page()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.page_admins (page_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'admin');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_page_created
AFTER INSERT ON public.pages
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_page();
