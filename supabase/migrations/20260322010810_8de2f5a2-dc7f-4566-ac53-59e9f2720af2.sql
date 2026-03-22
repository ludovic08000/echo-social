
-- User public keys for E2EE key exchange
CREATE TABLE public.user_public_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  identity_key TEXT NOT NULL,
  signing_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kem_type TEXT NOT NULL DEFAULT 'ECDH-P384',
  pq_public_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(user_id, is_active)
);

-- Enable RLS
ALTER TABLE public.user_public_keys ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read public keys (needed for key exchange)
CREATE POLICY "Authenticated users can read public keys"
ON public.user_public_keys FOR SELECT
TO authenticated
USING (true);

-- Users can only insert/update their own keys
CREATE POLICY "Users can insert own keys"
ON public.user_public_keys FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own keys"
ON public.user_public_keys FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- Index for fast lookups
CREATE INDEX idx_user_public_keys_user_active ON public.user_public_keys (user_id, is_active) WHERE is_active = true;

-- Enable realtime for key updates (key rotation notifications)
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_public_keys;
