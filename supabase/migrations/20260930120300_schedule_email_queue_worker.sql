-- Keep authentication e-mails (including unusual-login approvals) moving.
-- The dispatcher is private, reads its credential from Vault, and avoids an
-- outbound request when both queues are empty or delivery is rate-limited.

BEGIN;

CREATE OR REPLACE FUNCTION public.process_email_queue_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_service_secret text;
  v_retry_after timestamptz;
  v_auth_visible bigint := 0;
  v_transactional_visible bigint := 0;
BEGIN
  SELECT state.retry_after_until
  INTO v_retry_after
  FROM public.email_send_state AS state
  WHERE state.id = 1;

  IF v_retry_after IS NOT NULL AND v_retry_after > pg_catalog.now() THEN
    RETURN;
  END IF;

  SELECT pg_catalog.coalesce(metrics.queue_visible_length, 0)
  INTO v_auth_visible
  FROM pgmq.metrics('auth_emails') AS metrics;

  SELECT pg_catalog.coalesce(metrics.queue_visible_length, 0)
  INTO v_transactional_visible
  FROM pgmq.metrics('transactional_emails') AS metrics;

  IF v_auth_visible + v_transactional_visible = 0 THEN
    RETURN;
  END IF;

  SELECT secret.decrypted_secret
  INTO v_service_secret
  FROM vault.decrypted_secrets AS secret
  WHERE secret.name = 'email_queue_service_role_key'
  LIMIT 1;

  IF v_service_secret IS NULL OR pg_catalog.length(v_service_secret) = 0 THEN
    RAISE WARNING 'Email queue service credential is unavailable';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://vkpmoqfzrihcijjochks.supabase.co/functions/v1/process-email-queue',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_secret,
      'apikey', v_service_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
EXCEPTION WHEN OTHERS THEN
  -- Cron must retry on the next tick without exposing credentials in logs.
  RAISE WARNING 'Email queue dispatcher failed';
END;
$function$;

REVOKE ALL ON FUNCTION public.process_email_queue_cron_tick()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_email_queue_cron_tick()
TO service_role;

DO $schedule$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT job.jobid
    FROM cron.job AS job
    WHERE job.jobname = 'process-email-queue'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'process-email-queue',
    '5 seconds',
    'SELECT public.process_email_queue_cron_tick();'
  );
END;
$schedule$;

COMMIT;
