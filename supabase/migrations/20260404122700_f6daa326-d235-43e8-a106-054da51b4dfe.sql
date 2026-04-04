-- Fix stories INSERT policy: must be TO authenticated
DROP POLICY IF EXISTS "Users can create their own stories" ON public.stories;
CREATE POLICY "Users can create their own stories" ON public.stories
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Fix stories DELETE policy: must be TO authenticated
DROP POLICY IF EXISTS "Users can delete their own stories" ON public.stories;
CREATE POLICY "Users can delete their own stories" ON public.stories
FOR DELETE TO authenticated
USING (auth.uid() = user_id);

-- Fix story_views INSERT policy: must be TO authenticated
DROP POLICY IF EXISTS "Authenticated users can mark stories as viewed" ON public.story_views;
CREATE POLICY "Authenticated users can mark stories as viewed" ON public.story_views
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = viewer_id);

-- Fix story_views SELECT policy: must be TO authenticated
DROP POLICY IF EXISTS "Story owners can view who viewed their stories" ON public.story_views;
CREATE POLICY "Story owners can view who viewed their stories" ON public.story_views
FOR SELECT TO authenticated
USING (
  (EXISTS (
    SELECT 1 FROM stories
    WHERE stories.id = story_views.story_id AND stories.user_id = auth.uid()
  )) OR (viewer_id = auth.uid())
);