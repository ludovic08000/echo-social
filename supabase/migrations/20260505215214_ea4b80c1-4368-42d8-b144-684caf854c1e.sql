CREATE TABLE public.message_read_receipts (
  message_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, device_id)
);

CREATE INDEX idx_mrr_conversation ON public.message_read_receipts(conversation_id, user_id);
CREATE INDEX idx_mrr_message ON public.message_read_receipts(message_id);

ALTER TABLE public.message_read_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view receipts in their conversations"
ON public.message_read_receipts FOR SELECT
TO authenticated
USING (public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "Users can insert their own read receipts"
ON public.message_read_receipts FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND public.is_conversation_participant(conversation_id, auth.uid())
);

CREATE POLICY "Users can update their own read receipts"
ON public.message_read_receipts FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own read receipts"
ON public.message_read_receipts FOR DELETE
TO authenticated
USING (user_id = auth.uid());