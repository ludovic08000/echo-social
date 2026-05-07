
-- Sender Keys foundation (Signal Sender Keys protocol)

-- Per-conversation, per-sender-device chain state
CREATE TABLE IF NOT EXISTS public.sender_key_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL,
  sender_device_id text NOT NULL,
  chain_key_b64 text NOT NULL,        -- 32-byte chain key (current iteration)
  iteration integer NOT NULL DEFAULT 0,
  signing_pub_b64 text NOT NULL,       -- Ed25519 / ECDSA pub for header signature
  signing_priv_jwk jsonb,              -- only present on owner row (NULL for receiver mirrors)
  is_owner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sender_user_id, sender_device_id)
);

CREATE INDEX IF NOT EXISTS idx_sender_key_state_conv ON public.sender_key_state(conversation_id);

ALTER TABLE public.sender_key_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sk_state_select_self_or_member"
ON public.sender_key_state FOR SELECT TO authenticated
USING (
  is_conversation_participant(conversation_id, auth.uid())
  AND (sender_user_id = auth.uid() OR NOT is_owner)
);

CREATE POLICY "sk_state_insert_self"
ON public.sender_key_state FOR INSERT TO authenticated
WITH CHECK (
  is_conversation_participant(conversation_id, auth.uid())
  AND sender_user_id = auth.uid()
);

CREATE POLICY "sk_state_update_self"
ON public.sender_key_state FOR UPDATE TO authenticated
USING (sender_user_id = auth.uid())
WITH CHECK (sender_user_id = auth.uid());

CREATE POLICY "sk_state_delete_self"
ON public.sender_key_state FOR DELETE TO authenticated
USING (sender_user_id = auth.uid());

-- Distribution queue: sender posts encrypted SKDM (sender key distribution
-- message) to each recipient device using the pairwise device ratchet.
CREATE TABLE IF NOT EXISTS public.sender_key_distribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL,
  sender_device_id text NOT NULL,
  recipient_user_id uuid NOT NULL,
  recipient_device_id text NOT NULL,
  encrypted_skdm text NOT NULL,        -- ratchet-encrypted SKDM payload
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skd_recipient
  ON public.sender_key_distribution(recipient_user_id, recipient_device_id, delivered);

ALTER TABLE public.sender_key_distribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skd_select_recipient_or_sender"
ON public.sender_key_distribution FOR SELECT TO authenticated
USING (recipient_user_id = auth.uid() OR sender_user_id = auth.uid());

CREATE POLICY "skd_insert_sender"
ON public.sender_key_distribution FOR INSERT TO authenticated
WITH CHECK (
  sender_user_id = auth.uid()
  AND is_conversation_participant(conversation_id, auth.uid())
);

CREATE POLICY "skd_update_recipient_mark_delivered"
ON public.sender_key_distribution FOR UPDATE TO authenticated
USING (recipient_user_id = auth.uid())
WITH CHECK (recipient_user_id = auth.uid());

-- Trigger to maintain updated_at
CREATE TRIGGER trg_sender_key_state_updated_at
BEFORE UPDATE ON public.sender_key_state
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Opt-in flag per conversation (default false; enable after a group has
-- successfully distributed sender keys to all member devices).
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS enable_sender_keys boolean NOT NULL DEFAULT false;
