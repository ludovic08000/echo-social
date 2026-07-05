-- =============================================================================
-- ML embeddings hourly cron + fix for security-monitor cron URL
-- =============================================================================
-- Project ref: vkpmoqfzrihcijjochks  (URL is public, safe to hardcode)
-- Requires vault secret 'service_role_key'. If missing, both cron ticks
-- install cleanly but stay no-op (fail-soft) until the secret is added.
-- =============================================================================

-- Ensure required extensions (idempotent; already enabled on this project)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- -----------------------------------------------------------------------------
-- 1) Hourly ML embeddings tick
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ml_embeddings_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  project_url  text := 'https://vkpmoqfzrihcijjochks.supabase.co';
  service_role text;
BEGIN
  SELECT decrypted_secret INTO service_role
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF service_role IS NULL OR length(service_role) = 0 THEN
    RAISE NOTICE 'Vault secret service_role_key missing; skipping ml-twotower-train http call';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := project_url || '/functions/v1/ml-twotower-train',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || service_role,
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ml-twotower-train http call failed: %', sqlerrm;
  END;
END;
$function$;

-- Idempotent schedule (hourly at minute 0)
-- To change frequency: unschedule below then reschedule with e.g. '*/30 * * * *' for every 30 min.
-- To fully revert:
--   SELECT cron.unschedule('forsure-ml-embeddings-hourly');
--   DROP FUNCTION IF EXISTS public.ml_embeddings_cron_tick();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'forsure-ml-embeddings-hourly') THEN
    PERFORM cron.unschedule('forsure-ml-embeddings-hourly');
  END IF;
END $$;

SELECT cron.schedule(
  'forsure-ml-embeddings-hourly',
  '0 * * * *',
  $$ SELECT public.ml_embeddings_cron_tick(); $$
);

-- -----------------------------------------------------------------------------
-- 2) Fix security_monitor_cron_tick (was reading NULL app.supabase_url)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.security_monitor_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  project_url  text := 'https://vkpmoqfzrihcijjochks.supabase.co';
  service_role text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO service_role
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

    IF service_role IS NOT NULL AND length(service_role) > 0 THEN
      PERFORM net.http_post(
        url := project_url || '/functions/v1/security-monitor',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || service_role,
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 15000
      );
    ELSE
      RAISE NOTICE 'Vault secret service_role_key missing; skipping security-monitor http call';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'security-monitor http call failed: %', sqlerrm;
  END;

  PERFORM public.apply_security_auto_mitigations();
END;
$function$;
