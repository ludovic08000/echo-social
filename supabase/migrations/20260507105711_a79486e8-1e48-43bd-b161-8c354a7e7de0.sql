-- Add group call columns to active_calls
ALTER TABLE public.active_calls
  ADD COLUMN IF NOT EXISTS caller_ids uuid[] DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accepted_by uuid[] DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS declined_by uuid[] DEFAULT '{}'::uuid[];

CREATE INDEX IF NOT EXISTS idx_active_calls_caller_ids ON public.active_calls USING GIN(caller_ids);

-- Add participants array to call_history for groups
ALTER TABLE public.call_history
  ADD COLUMN IF NOT EXISTS participants uuid[] DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_call_history_participants ON public.call_history USING GIN(participants);

-- Update RLS: allow group invitees to SELECT/UPDATE the active_call
DROP POLICY IF EXISTS "Group invitees can view active calls" ON public.active_calls;
CREATE POLICY "Group invitees can view active calls"
  ON public.active_calls
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = caller_id
    OR auth.uid() = callee_id
    OR auth.uid() = ANY(COALESCE(caller_ids, '{}'::uuid[]))
  );

DROP POLICY IF EXISTS "Group invitees can update active calls" ON public.active_calls;
CREATE POLICY "Group invitees can update active calls"
  ON public.active_calls
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = caller_id
    OR auth.uid() = callee_id
    OR auth.uid() = ANY(COALESCE(caller_ids, '{}'::uuid[]))
  );

-- Trigger: auto-end group call when all invitees declined
CREATE OR REPLACE FUNCTION public.auto_end_declined_group_call()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_group = true
     AND NEW.status = 'ringing'
     AND COALESCE(array_length(NEW.declined_by, 1), 0) >= COALESCE(array_length(NEW.caller_ids, 1), 0)
     AND COALESCE(array_length(NEW.caller_ids, 1), 0) > 0
     AND COALESCE(array_length(NEW.accepted_by, 1), 0) = 0
  THEN
    NEW.status := 'declined';
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_end_declined_group_call ON public.active_calls;
CREATE TRIGGER trg_auto_end_declined_group_call
  BEFORE UPDATE ON public.active_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_end_declined_group_call();