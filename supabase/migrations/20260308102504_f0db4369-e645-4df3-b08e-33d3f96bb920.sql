-- Allow creators to delete their own live streams
CREATE POLICY "Users can delete their own lives"
ON public.live_streams
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- Allow service role to delete old live chat/views (for cleanup)
-- live_chat already has delete policy for own messages, add broader for cleanup
-- live_views needs a delete policy
CREATE POLICY "Users can delete their own views"
ON public.live_views
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);