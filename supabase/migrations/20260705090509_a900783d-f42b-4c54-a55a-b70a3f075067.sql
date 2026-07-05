
-- 1) Anonymous wall: hide author_id from clients (anonymity)
REVOKE SELECT (author_id) ON public.anonymous_wall_messages FROM anon, authenticated;

-- 2) Notifications: tighten INSERT + rate limit spam
DROP POLICY IF EXISTS "Users can create notifications" ON public.notifications;
CREATE POLICY "Users can create notifications"
  ON public.notifications
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = actor_id
    AND actor_id <> user_id
  );

CREATE OR REPLACE FUNCTION public.notifications_rate_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recent_count int;
BEGIN
  -- Skip rate limit when inserted by service_role / trusted server side
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO recent_count
  FROM public.notifications
  WHERE actor_id = NEW.actor_id
    AND user_id = NEW.user_id
    AND created_at > now() - interval '1 hour';

  IF recent_count >= 30 THEN
    RAISE EXCEPTION 'notification_rate_limited'
      USING HINT = 'Too many notifications to this recipient';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notifications_rate_limit ON public.notifications;
CREATE TRIGGER trg_notifications_rate_limit
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_rate_limit();

-- 3) Quality events: authenticated only + user_id must match caller
DROP POLICY IF EXISTS "qe_insert_anyone" ON public.quality_events;
CREATE POLICY "qe_insert_authenticated_self"
  ON public.quality_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND (user_id IS NULL OR user_id = auth.uid())
  );

-- 4) Groups: hide private groups from non-members
DROP POLICY IF EXISTS "Public groups are viewable by everyone" ON public.groups;
CREATE POLICY "Groups visibility: public or members"
  ON public.groups
  FOR SELECT
  TO authenticated
  USING (
    privacy = 'public'
    OR created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_members.group_id = groups.id
        AND group_members.user_id = auth.uid()
    )
  );
