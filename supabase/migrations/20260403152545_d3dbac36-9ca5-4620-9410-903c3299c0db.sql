
-- Table for ephemeral device-link tokens (QR-based key transfer)
CREATE TABLE public.device_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  encrypted_payload text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast token lookup
CREATE INDEX idx_device_link_tokens_hash ON public.device_link_tokens(token_hash);
CREATE INDEX idx_device_link_tokens_expires ON public.device_link_tokens(expires_at);

-- Enable RLS
ALTER TABLE public.device_link_tokens ENABLE ROW LEVEL SECURITY;

-- Only the owner can create/read their tokens
CREATE POLICY "Users can create own link tokens"
  ON public.device_link_tokens FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can read own link tokens"
  ON public.device_link_tokens FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can update own link tokens"
  ON public.device_link_tokens FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete own link tokens"
  ON public.device_link_tokens FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Auto-cleanup expired tokens
CREATE OR REPLACE FUNCTION public.cleanup_expired_device_links()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.device_link_tokens WHERE expires_at < now();
END;
$$;
