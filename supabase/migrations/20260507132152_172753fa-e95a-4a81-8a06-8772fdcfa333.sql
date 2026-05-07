
-- Append-only transparency log
CREATE TABLE IF NOT EXISTS public.e2ee_transparency_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  fingerprint TEXT,
  identity_epoch INTEGER,
  device_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  leaf_hash TEXT,
  included_in_epoch BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kt_log_user ON public.e2ee_transparency_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kt_log_pending ON public.e2ee_transparency_log(included_in_epoch) WHERE included_in_epoch IS NULL;

ALTER TABLE public.e2ee_transparency_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kt_log_owner_read" ON public.e2ee_transparency_log
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "kt_log_authenticated_insert_self" ON public.e2ee_transparency_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Signed Merkle tree heads (one row per epoch)
CREATE TABLE IF NOT EXISTS public.e2ee_kt_tree_heads (
  epoch BIGINT PRIMARY KEY,
  root_hash TEXT NOT NULL,
  leaf_count BIGINT NOT NULL,
  prev_epoch BIGINT REFERENCES public.e2ee_kt_tree_heads(epoch),
  signing_key_id UUID NOT NULL,
  signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.e2ee_kt_tree_heads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kt_heads_public_read" ON public.e2ee_kt_tree_heads
  FOR SELECT USING (true);

-- Per-leaf entries (Merkle audit data)
CREATE TABLE IF NOT EXISTS public.e2ee_kt_leaves (
  epoch BIGINT NOT NULL REFERENCES public.e2ee_kt_tree_heads(epoch) ON DELETE CASCADE,
  leaf_index BIGINT NOT NULL,
  log_id BIGINT NOT NULL REFERENCES public.e2ee_transparency_log(id) ON DELETE CASCADE,
  leaf_hash TEXT NOT NULL,
  PRIMARY KEY (epoch, leaf_index)
);
CREATE INDEX IF NOT EXISTS idx_kt_leaves_log ON public.e2ee_kt_leaves(log_id);

ALTER TABLE public.e2ee_kt_leaves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kt_leaves_public_read" ON public.e2ee_kt_leaves
  FOR SELECT USING (true);

-- Server signing key history
CREATE TABLE IF NOT EXISTS public.e2ee_kt_signing_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key_jwk JSONB NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'Ed25519',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ
);

ALTER TABLE public.e2ee_kt_signing_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kt_keys_public_read" ON public.e2ee_kt_signing_keys
  FOR SELECT USING (true);
