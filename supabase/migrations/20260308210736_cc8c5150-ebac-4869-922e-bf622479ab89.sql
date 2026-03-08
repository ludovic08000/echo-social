-- Point 13/14: Albums RLS - enforce privacy field
DROP POLICY IF EXISTS "Albums are viewable by everyone" ON public.albums;
CREATE POLICY "Albums viewable based on privacy" ON public.albums
FOR SELECT USING (
  privacy = 'public'
  OR user_id = auth.uid()
  OR (privacy = 'friends' AND EXISTS (
    SELECT 1 FROM friendships
    WHERE status = 'accepted'
    AND (
      (requester_id = auth.uid() AND addressee_id = albums.user_id)
      OR (addressee_id = auth.uid() AND requester_id = albums.user_id)
    )
  ))
);

-- Album media: inherit album privacy
DROP POLICY IF EXISTS "Album media is viewable by everyone" ON public.album_media;
CREATE POLICY "Album media viewable based on album privacy" ON public.album_media
FOR SELECT USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM albums a
    WHERE a.id = album_media.album_id
    AND (
      a.privacy = 'public'
      OR a.user_id = auth.uid()
      OR (a.privacy = 'friends' AND EXISTS (
        SELECT 1 FROM friendships
        WHERE status = 'accepted'
        AND (
          (requester_id = auth.uid() AND addressee_id = a.user_id)
          OR (addressee_id = auth.uid() AND requester_id = a.user_id)
        )
      ))
    )
  )
);

-- Point 15: security_logs - restrict insert to service role only (remove client insert)
DROP POLICY IF EXISTS "Authenticated users can insert own logs" ON public.security_logs;
CREATE POLICY "Only admins can insert security logs" ON public.security_logs
FOR INSERT WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- message-moderation: add conversation participant check for accept/reject
-- (handled in edge function code, not RLS)