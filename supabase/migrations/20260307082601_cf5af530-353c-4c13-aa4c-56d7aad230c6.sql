
-- Table for "delete for me" functionality
CREATE TABLE public.message_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

ALTER TABLE public.message_deletions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can hide messages for themselves"
  ON public.message_deletions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own deletions"
  ON public.message_deletions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can undo deletions"
  ON public.message_deletions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Allow message senders to delete their own messages (for everyone)
CREATE POLICY "Senders can delete their messages"
  ON public.messages FOR DELETE
  TO authenticated
  USING (auth.uid() = sender_id);

-- Add recording_url to live_streams for auto-recording
ALTER TABLE public.live_streams ADD COLUMN IF NOT EXISTS recording_url text;

-- Subscribe to realtime for message deletions  
ALTER PUBLICATION supabase_realtime ADD TABLE public.message_deletions;
