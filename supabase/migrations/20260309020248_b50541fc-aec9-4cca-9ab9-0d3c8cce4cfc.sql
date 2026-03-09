
-- Table to signal active calls between users (for incoming call notifications)
CREATE TABLE public.active_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  caller_id UUID NOT NULL,
  callee_id UUID NOT NULL,
  call_type TEXT NOT NULL DEFAULT 'audio',
  status TEXT NOT NULL DEFAULT 'ringing',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  answered_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE
);

-- RLS
ALTER TABLE public.active_calls ENABLE ROW LEVEL SECURITY;

-- Caller can insert/update/select their own calls
CREATE POLICY "Caller can manage their calls"
  ON public.active_calls
  FOR ALL
  TO authenticated
  USING (caller_id = auth.uid() OR callee_id = auth.uid())
  WITH CHECK (caller_id = auth.uid());

-- Callee can read and update (accept/decline)
CREATE POLICY "Callee can update call status"
  ON public.active_calls
  FOR UPDATE
  TO authenticated
  USING (callee_id = auth.uid())
  WITH CHECK (callee_id = auth.uid());

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.active_calls;

-- Auto-cleanup old calls (older than 2 minutes = expired)
CREATE INDEX idx_active_calls_status ON public.active_calls(status, created_at);
