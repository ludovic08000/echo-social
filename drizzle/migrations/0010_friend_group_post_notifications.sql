ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'close_friend_post';

CREATE OR REPLACE FUNCTION public.notify_friend_group_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, type, actor_id, post_id)
  SELECT DISTINCT
    friend_group.user_id,
    'close_friend_post'::public.notification_type,
    NEW.user_id,
    NEW.id
  FROM public.friend_group_members AS member
  JOIN public.friend_groups AS friend_group
    ON friend_group.id = member.group_id
  JOIN public.notification_settings AS settings
    ON settings.user_id = friend_group.user_id
   AND settings.close_friends_posts_enabled = true
  WHERE member.friend_user_id = NEW.user_id
    AND friend_group.user_id <> NEW.user_id
    AND EXISTS (
      SELECT 1
      FROM public.friendships AS friendship
      WHERE friendship.status = 'accepted'
        AND (
          (friendship.requester_id = friend_group.user_id AND friendship.addressee_id = NEW.user_id)
          OR
          (friendship.addressee_id = friend_group.user_id AND friendship.requester_id = NEW.user_id)
        )
    );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.notify_friend_group_post()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notify_friend_group_post ON public.posts;
CREATE TRIGGER trg_notify_friend_group_post
AFTER INSERT ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.notify_friend_group_post();