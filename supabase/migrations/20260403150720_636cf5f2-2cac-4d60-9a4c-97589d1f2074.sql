
-- Validate that caller and callee both belong to the conversation before inserting a call
CREATE OR REPLACE FUNCTION public.validate_call_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Verify caller belongs to the conversation
  IF NOT EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = NEW.conversation_id
      AND user_id = NEW.caller_id
  ) THEN
    RAISE EXCEPTION 'Caller is not a participant of this conversation';
  END IF;

  -- Verify callee belongs to the conversation
  IF NOT EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = NEW.conversation_id
      AND user_id = NEW.callee_id
  ) THEN
    RAISE EXCEPTION 'Callee is not a participant of this conversation';
  END IF;

  -- Prevent calling yourself
  IF NEW.caller_id = NEW.callee_id THEN
    RAISE EXCEPTION 'Cannot call yourself';
  END IF;

  RETURN NEW;
END;
$$;

-- Attach trigger to active_calls table
DROP TRIGGER IF EXISTS trg_validate_call_participants ON public.active_calls;
CREATE TRIGGER trg_validate_call_participants
  BEFORE INSERT ON public.active_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_call_participants();

-- Also store peer fingerprints server-side for cross-device verification
CREATE TABLE IF NOT EXISTS public.user_known_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  peer_user_id uuid NOT NULL,
  fingerprint text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged boolean NOT NULL DEFAULT true,
  UNIQUE(user_id, peer_user_id)
);

ALTER TABLE public.user_known_fingerprints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own fingerprints"
ON public.user_known_fingerprints
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_known_fingerprints TO authenticated;
