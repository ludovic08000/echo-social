-- 1. FIX: group_members self-referencing RLS
DROP POLICY IF EXISTS "Admins can update member roles" ON public.group_members;
CREATE POLICY "Admins can update member roles" ON public.group_members
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = group_members.group_id
        AND gm.user_id = auth.uid()
        AND gm.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Users can leave groups" ON public.group_members;
CREATE POLICY "Users can leave groups" ON public.group_members
  FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = group_members.group_id
        AND gm.user_id = auth.uid()
        AND gm.role = 'admin'
    )
  );

-- 2. FIX: notifications INSERT spoofing
DROP POLICY IF EXISTS "Users can create notifications" ON public.notifications;
CREATE POLICY "Users can create notifications" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = actor_id);

-- 3. FIX: tips INSERT - restrict to own tipper_id
DROP POLICY IF EXISTS "System can insert tips" ON public.tips;
CREATE POLICY "Users can insert own tips" ON public.tips
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = tipper_id);

-- 4. FIX: order_items INSERT - restrict to order buyer
DROP POLICY IF EXISTS "System can create order items" ON public.order_items;
CREATE POLICY "Buyer can create order items" ON public.order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id
        AND o.buyer_id = auth.uid()
    )
  );

-- 5. FIX: trust_scores - restrict to owner only
DROP POLICY IF EXISTS "Trust scores are publicly readable" ON public.trust_scores;
CREATE POLICY "Users can read own trust score" ON public.trust_scores
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Public trust score via function
CREATE OR REPLACE FUNCTION public.get_public_trust_score(p_user_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT trust_score FROM trust_scores WHERE user_id = p_user_id;
$$;

-- 6. FIX: stories - restrict to friends + owner
DROP POLICY IF EXISTS "Users can view stories from friends or own" ON public.stories;
CREATE POLICY "Users can view stories from friends or own" ON public.stories
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.friendships
      WHERE status = 'accepted'
        AND (
          (requester_id = auth.uid() AND addressee_id = stories.user_id)
          OR (addressee_id = auth.uid() AND requester_id = stories.user_id)
        )
    )
  );