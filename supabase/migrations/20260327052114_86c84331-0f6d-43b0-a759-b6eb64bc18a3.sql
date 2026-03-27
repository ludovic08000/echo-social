
-- Fix search_path on audit trigger functions
CREATE OR REPLACE FUNCTION public.log_message_sent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO audit_logs (user_id, event_type, conversation_id, status)
  VALUES (NEW.sender_id, 'message_sent', NEW.conversation_id, NEW.status);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_post_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO audit_logs (user_id, event_type, post_id, media_id)
  VALUES (NEW.user_id, 'post_created', NEW.id, NEW.image_url);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_post_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO audit_logs (user_id, event_type, post_id)
  VALUES (OLD.user_id, 'post_deleted', OLD.id);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_abuse_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO audit_logs (user_id, event_type, target_user_id, reason_code, status)
  VALUES (NEW.reporter_id, 'account_reported', NEW.reported_user_id, NEW.report_type, NEW.status);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_ban_applied()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO audit_logs (user_id, event_type, target_user_id, reason_code, status)
  VALUES (NEW.banned_by, 'ban_applied', NEW.user_id, NEW.reason, 'success');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_live_started()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.is_active = true AND (OLD IS NULL OR OLD.is_active = false) THEN
    INSERT INTO audit_logs (user_id, event_type, live_id)
    VALUES (NEW.user_id, 'live_started', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

-- Fix the service_role policy to be more specific
DROP POLICY IF EXISTS "Service role inserts audit logs" ON public.audit_logs;
