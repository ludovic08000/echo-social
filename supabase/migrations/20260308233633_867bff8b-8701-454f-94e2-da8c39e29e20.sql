CREATE TABLE public.zeus_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  title text DEFAULT 'Conversation Zeus',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.zeus_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own zeus conversations"
ON public.zeus_conversations
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());