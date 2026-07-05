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
  WHERE name = 'email_queue_service_role_key'
  LIMIT 1;

  IF service_role IS NULL OR length(service_role) = 0 THEN
    RAISE NOTICE 'Vault secret email_queue_service_role_key missing; skipping ml-twotower-train http call';
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
    WHERE name = 'email_queue_service_role_key'
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
      RAISE NOTICE 'Vault secret email_queue_service_role_key missing; skipping security-monitor http call';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'security-monitor http call failed: %', sqlerrm;
  END;

  PERFORM public.apply_security_auto_mitigations();
END;
$function$;