
-- Signed prekeys (medium-term X25519 keys signed by Ed25519 identity key)
CREATE TABLE public.user_signed_prekeys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  spk_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '30 days'),
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(user_id, spk_id)
);

ALTER TABLE public.user_signed_prekeys ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read signed prekeys (needed for X3DH handshake)
CREATE POLICY "Anyone can read signed prekeys"
  ON public.user_signed_prekeys FOR SELECT
  TO authenticated
  USING (true);

-- Only owner can insert/update their own signed prekeys
CREATE POLICY "Users can manage own signed prekeys"
  ON public.user_signed_prekeys FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own signed prekeys"
  ON public.user_signed_prekeys FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

-- Function to get active signed prekey for a user
CREATE OR REPLACE FUNCTION public.get_signed_prekey(p_user_id uuid)
RETURNS TABLE(spk_id integer, public_key text, signature text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sp.spk_id, sp.public_key, sp.signature
  FROM public.user_signed_prekeys sp
  WHERE sp.user_id = p_user_id
    AND sp.is_active = true
    AND sp.expires_at > now()
  ORDER BY sp.created_at DESC
  LIMIT 1;
$$;
