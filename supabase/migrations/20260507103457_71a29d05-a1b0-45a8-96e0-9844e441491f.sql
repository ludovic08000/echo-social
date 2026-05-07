
-- 1. Add room_id to active_calls (for group calls; NULL = 1-1 derives from conv id)
ALTER TABLE public.active_calls
  ADD COLUMN IF NOT EXISTS room_id text;

-- 2. call_history table
CREATE TABLE IF NOT EXISTS public.call_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid,
  conversation_id uuid NOT NULL,
  caller_id uuid NOT NULL,
  callee_id uuid NOT NULL,
  call_type text NOT NULL DEFAULT 'audio',
  final_status text NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_history_caller ON public.call_history(caller_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_history_callee ON public.call_history(callee_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_history_conv ON public.call_history(conversation_id, ended_at DESC);

ALTER TABLE public.call_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "participants_select_history" ON public.call_history;
CREATE POLICY "participants_select_history"
  ON public.call_history FOR SELECT
  TO authenticated
  USING (caller_id = auth.uid() OR callee_id = auth.uid());

-- 3. Auto-log trigger: when active_calls reaches a terminal status, copy to history
CREATE OR REPLACE FUNCTION public.log_call_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv_uuid uuid;
  v_duration int;
  v_started timestamptz;
  v_ended timestamptz;
BEGIN
  -- Only fire on transition to terminal status
  IF NEW.status NOT IN ('ended','declined','cancelled','missed','no_answer','expired') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Tolerate text conv ids (active_calls.conversation_id is text)
  BEGIN
    v_conv_uuid := NEW.conversation_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;

  v_started := COALESCE(NEW.created_at, now());
  v_ended := COALESCE(NEW.ended_at, now());
  v_duration := GREATEST(
    0,
    EXTRACT(EPOCH FROM (v_ended - COALESCE(NEW.answered_at, v_ended)))::int
  );

  INSERT INTO public.call_history (
    call_id, conversation_id, caller_id, callee_id,
    call_type, final_status, duration_seconds, started_at, ended_at
  ) VALUES (
    NEW.id, v_conv_uuid, NEW.caller_id, NEW.callee_id,
    NEW.call_type, NEW.status, v_duration, v_started, v_ended
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_call_history ON public.active_calls;
CREATE TRIGGER trg_log_call_history
  AFTER UPDATE ON public.active_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.log_call_history();

-- 4. Push trigger on incoming call INSERT — fires push-notify edge function via pg_net
CREATE OR REPLACE FUNCTION public.notify_incoming_call_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_name text;
  v_payload jsonb;
  v_url text := current_setting('app.settings.functions_url', true);
BEGIN
  -- Only ringing inserts
  IF NEW.status <> 'ringing' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(name, 'Quelqu''un') INTO v_caller_name
    FROM public.profiles WHERE user_id = NEW.caller_id LIMIT 1;

  v_payload := jsonb_build_object(
    'user_id', NEW.callee_id,
    'title', COALESCE(v_caller_name, 'Appel entrant'),
    'body', CASE WHEN NEW.call_type='video' THEN 'Appel vidéo entrant' ELSE 'Appel audio entrant' END,
    'url', '/messages?conv=' || NEW.conversation_id,
    'tag', 'call-' || NEW.id::text,
    'kind', 'call_incoming',
    'requireInteraction', true
  );

  -- Fire-and-forget HTTP via pg_net (best-effort; never block call signaling)
  BEGIN
    PERFORM net.http_post(
      url := COALESCE(NULLIF(v_url,''),
                      'https://vkpmoqfzrihcijjochks.supabase.co/functions/v1') || '/push-notify',
      headers := jsonb_build_object('Content-Type','application/json'),
      body := v_payload
    );
  EXCEPTION WHEN OTHERS THEN
    -- Swallow; logging the call must always succeed
    NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_incoming_call_push ON public.active_calls;
CREATE TRIGGER trg_notify_incoming_call_push
  AFTER INSERT ON public.active_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_incoming_call_push();
