
-- Prekey bundle table (Signal-style one-time prekeys)
CREATE TABLE public.user_prekeys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prekey_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  consumed_by UUID REFERENCES auth.users(id),
  UNIQUE(user_id, prekey_id)
);

-- Index for fast lookup of available prekeys
CREATE INDEX idx_user_prekeys_available ON public.user_prekeys (user_id, consumed_at) WHERE consumed_at IS NULL;

-- RLS
ALTER TABLE public.user_prekeys ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read available prekeys (needed to initiate encryption)
CREATE POLICY "Anyone can read available prekeys"
  ON public.user_prekeys
  FOR SELECT
  TO authenticated
  USING (consumed_at IS NULL);

-- Users can insert their own prekeys
CREATE POLICY "Users can insert own prekeys"
  ON public.user_prekeys
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Users can consume a prekey (mark it as used) - but only for other users' prekeys
CREATE POLICY "Users can consume prekeys"
  ON public.user_prekeys
  FOR UPDATE
  TO authenticated
  USING (consumed_at IS NULL AND user_id != auth.uid())
  WITH CHECK (consumed_by = auth.uid());

-- Users can delete their own prekeys (for cleanup/regeneration)
CREATE POLICY "Users can delete own prekeys"
  ON public.user_prekeys
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Function to atomically consume a prekey (prevents race conditions)
CREATE OR REPLACE FUNCTION public.consume_prekey(p_peer_user_id UUID)
RETURNS TABLE(prekey_id INTEGER, public_key TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.user_prekeys pk
  SET consumed_at = now(), consumed_by = auth.uid()
  WHERE pk.id = (
    SELECT pk2.id FROM public.user_prekeys pk2
    WHERE pk2.user_id = p_peer_user_id
      AND pk2.consumed_at IS NULL
    ORDER BY pk2.prekey_id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING pk.prekey_id, pk.public_key;
END;
$$;
