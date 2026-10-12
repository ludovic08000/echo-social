-- Stories : les visiteurs non connectés voyaient toutes les stories, contournant la règle amis.
DROP POLICY IF EXISTS "Guests can view stories" ON public.stories;

-- Likes de story : seulement si la story elle-même est visible par l'appelant.
DROP POLICY IF EXISTS "Anyone can view story likes" ON public.story_likes;
CREATE POLICY "Story likes visible with story" ON public.story_likes FOR SELECT TO authenticated
USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.stories s WHERE s.id = story_likes.story_id));

-- Vues de post : seulement pour les posts visibles par l'appelant.
DROP POLICY IF EXISTS "Anyone can view post views" ON public.post_views;
CREATE POLICY "Post views visible with post" ON public.post_views FOR SELECT TO authenticated
USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_views.post_id));

-- Prédictions ML : insertion limitée à ses propres lignes.
DROP POLICY IF EXISTS "Auth users can have predictions" ON public.ml_predictions;
CREATE POLICY "Users insert own predictions" ON public.ml_predictions FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Groupes : membres visibles uniquement par les membres du même groupe.
CREATE OR REPLACE FUNCTION public.is_group_member(_group_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.group_members WHERE group_id = _group_id AND user_id = _user_id)
$$;
DROP POLICY IF EXISTS "Users can view group members" ON public.group_members;
CREATE POLICY "Members can view group members" ON public.group_members FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_group_member(group_id, auth.uid()));

-- Pages (fonction retirée de l'app) : plus de lecture anonyme, téléphone non exposé publiquement.
DROP POLICY IF EXISTS "Pages are viewable by everyone" ON public.pages;
CREATE POLICY "Signed-in users can view pages" ON public.pages FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Page admins are viewable" ON public.page_admins;
CREATE POLICY "Page admins visible to admins" ON public.page_admins FOR SELECT TO authenticated
USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.pages p WHERE p.id = page_admins.page_id AND p.created_by = auth.uid()));
DROP POLICY IF EXISTS "Followers are viewable" ON public.page_followers;
CREATE POLICY "Own page follows visible" ON public.page_followers FOR SELECT TO authenticated
USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Page posts are viewable by everyone" ON public.page_posts;
CREATE POLICY "Signed-in users can view page posts" ON public.page_posts FOR SELECT TO authenticated USING (true);