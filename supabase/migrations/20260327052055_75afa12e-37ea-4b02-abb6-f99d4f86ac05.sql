
-- Audit logs table: RGPD-compliant metadata journal
-- No message content, no secrets, no precise geolocation
-- Retention: 6 months, auto-purged

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  device_fingerprint text,
  conversation_id uuid,
  live_id uuid,
  target_user_id uuid,
  media_id text,
  post_id uuid,
  status text DEFAULT 'success',
  reason_code text,
  metadata jsonb DEFAULT '{}'
);

-- Index for admin search by user
CREATE INDEX idx_audit_logs_user_id ON public.audit_logs(user_id);
CREATE INDEX idx_audit_logs_event_type ON public.audit_logs(event_type);
CREATE INDEX idx_audit_logs_created_at ON public.audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_target_user ON public.audit_logs(target_user_id) WHERE target_user_id IS NOT NULL;

-- RLS: only admins can read via security definer function
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Admin read-only policy
CREATE POLICY "Admins can read audit logs"
ON public.audit_logs FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- No direct insert from client - use server functions
-- Edge functions with service role will insert
CREATE POLICY "Service role inserts audit logs"
ON public.audit_logs FOR INSERT
TO service_role
WITH CHECK (true);

-- Auto-purge function for 6-month retention
CREATE OR REPLACE FUNCTION public.purge_old_audit_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.audit_logs WHERE created_at < now() - interval '6 months';
END;
$$;

-- Trigger to log message sends (metadata only, no content)
CREATE OR REPLACE FUNCTION public.log_message_sent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.audit_logs (user_id, event_type, conversation_id, status)
  VALUES (NEW.sender_id, 'message_sent', NEW.conversation_id, NEW.status);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_message_sent
AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.log_message_sent();

-- Trigger to log post creation
CREATE OR REPLACE FUNCTION public.log_post_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.audit_logs (user_id, event_type, post_id, media_id)
  VALUES (NEW.user_id, 'post_created', NEW.id, NEW.image_url);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_post_created
AFTER INSERT ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.log_post_created();

-- Trigger to log post deletion
CREATE OR REPLACE FUNCTION public.log_post_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.audit_logs (user_id, event_type, post_id)
  VALUES (OLD.user_id, 'post_deleted', OLD.id);
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_audit_post_deleted
AFTER DELETE ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.log_post_deleted();

-- Trigger to log abuse reports
CREATE OR REPLACE FUNCTION public.log_abuse_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.audit_logs (user_id, event_type, target_user_id, reason_code, status)
  VALUES (NEW.reporter_id, 'account_reported', NEW.reported_user_id, NEW.report_type, NEW.status);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_abuse_report
AFTER INSERT ON public.abuse_reports
FOR EACH ROW EXECUTE FUNCTION public.log_abuse_report();

-- Trigger to log bans
CREATE OR REPLACE FUNCTION public.log_ban_applied()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.audit_logs (user_id, event_type, target_user_id, reason_code, status)
  VALUES (NEW.banned_by, 'ban_applied', NEW.user_id, NEW.reason, 'success');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_ban_applied
AFTER INSERT ON public.banned_users
FOR EACH ROW EXECUTE FUNCTION public.log_ban_applied();

-- Trigger to log live stream start
CREATE OR REPLACE FUNCTION public.log_live_started()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.is_active = true AND (OLD IS NULL OR OLD.is_active = false) THEN
    INSERT INTO public.audit_logs (user_id, event_type, live_id)
    VALUES (NEW.user_id, 'live_started', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_live_started
AFTER INSERT OR UPDATE ON public.live_streams
FOR EACH ROW EXECUTE FUNCTION public.log_live_started();
