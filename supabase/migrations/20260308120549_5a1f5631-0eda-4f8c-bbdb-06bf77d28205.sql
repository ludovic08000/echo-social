
-- Fix groups UPDATE policy (was referencing group_members.id instead of groups.id)
DROP POLICY IF EXISTS "Group admins can update groups" ON public.groups;
CREATE POLICY "Group admins can update groups" ON public.groups
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM group_members
    WHERE group_members.group_id = groups.id
      AND group_members.user_id = auth.uid()
      AND group_members.role = 'admin'
  ));

-- Fix groups SELECT policy (was referencing group_members.id instead of groups.id)
DROP POLICY IF EXISTS "Public groups are viewable by everyone" ON public.groups;
CREATE POLICY "Public groups are viewable by everyone" ON public.groups
  FOR SELECT TO authenticated
  USING (
    privacy = 'public'
    OR privacy = 'private'
    OR EXISTS (
      SELECT 1 FROM group_members
      WHERE group_members.group_id = groups.id
        AND group_members.user_id = auth.uid()
    )
  );

-- Fix pages UPDATE policy (was referencing page_admins.id instead of pages.id)
DROP POLICY IF EXISTS "Page admins can update pages" ON public.pages;
CREATE POLICY "Page admins can update pages" ON public.pages
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM page_admins
    WHERE page_admins.page_id = pages.id
      AND page_admins.user_id = auth.uid()
      AND page_admins.role = 'admin'
  ));

-- Fix page_admins INSERT policy (self-referencing bug)
DROP POLICY IF EXISTS "Page admins can add other admins" ON public.page_admins;
CREATE POLICY "Page admins can add other admins" ON public.page_admins
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM page_admins pa
      WHERE pa.page_id = page_admins.page_id
        AND pa.user_id = auth.uid()
        AND pa.role = 'admin'
    )
    OR EXISTS (
      SELECT 1 FROM pages
      WHERE pages.id = page_admins.page_id
        AND pages.created_by = auth.uid()
    )
  );

-- Fix page_admins DELETE policy (self-referencing bug)
DROP POLICY IF EXISTS "Page admins can remove admins" ON public.page_admins;
CREATE POLICY "Page admins can remove admins" ON public.page_admins
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM page_admins pa
    WHERE pa.page_id = page_admins.page_id
      AND pa.user_id = auth.uid()
      AND pa.role = 'admin'
  ));
