BEGIN;

ALTER TABLE public.live_streams ADD COLUMN IF NOT EXISTS archive_expires_at timestamptz;
UPDATE public.live_streams SET archive_expires_at = coalesce(ended_at, started_at, created_at) + interval '30 days'
WHERE NOT is_active AND archive_expires_at IS NULL;
CREATE INDEX IF NOT EXISTS live_archive_expiry_idx ON public.live_streams(archive_expires_at) WHERE NOT is_active;

-- The browser cannot extend the broadcast clock or its retention window.
CREATE OR REPLACE FUNCTION public.guard_live_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_active THEN
      NEW.started_at := clock_timestamp(); NEW.ended_at := NULL; NEW.archive_expires_at := NULL;
    ELSE
      NEW.ended_at := clock_timestamp(); NEW.archive_expires_at := NEW.ended_at + interval '30 days';
    END IF;
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'LIVE_OWNER_IMMUTABLE'; END IF;
    NEW.started_at := OLD.started_at;
    IF NOT OLD.is_active AND NEW.is_active THEN RAISE EXCEPTION 'LIVE_ALREADY_ENDED'; END IF;
    IF OLD.is_active AND NOT NEW.is_active THEN
      NEW.ended_at := least(clock_timestamp(), coalesce(OLD.started_at, OLD.created_at) + interval '4 hours');
      NEW.archive_expires_at := NEW.ended_at + interval '30 days';
    ELSE
      NEW.ended_at := OLD.ended_at; NEW.archive_expires_at := OLD.archive_expires_at;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_live_lifecycle() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_live_lifecycle BEFORE INSERT OR UPDATE ON public.live_streams
FOR EACH ROW EXECUTE FUNCTION public.guard_live_lifecycle();

DROP POLICY IF EXISTS "Live archive retention" ON public.live_streams;
CREATE POLICY "Live archive retention" ON public.live_streams AS RESTRICTIVE FOR SELECT TO anon, authenticated
USING ((is_active AND started_at + interval '4 hours' > now())
  OR (NOT is_active AND archive_expires_at > now()));

-- Apply the same eligibility in the batched feed, which is SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.live_feed_bundle(p_user_id uuid, p_active_limit integer DEFAULT 80, p_replay_limit integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  viewer uuid := auth.uid(); active_items jsonb; replay_items jsonb; profiles jsonb; ranks jsonb;
BEGIN
  WITH ranked AS (SELECT * FROM public.live_score_batch(viewer, p_active_limit)),
  active AS (
    SELECT ls.id,ls.title,ls.description,ls.thumbnail_url,ls.is_active,ls.viewer_count,ls.peak_viewer_count,
      ls.total_views,ls.category,ls.hashtags,ls.user_id,ls.recording_url,ls.started_at,ls.created_at,
      NULL::timestamptz AS ended_at,coalesce(r.score,0)::numeric AS score
    FROM public.live_streams ls LEFT JOIN ranked r ON r.live_id=ls.id
    WHERE ls.is_active AND ls.started_at + interval '4 hours' > now()
    ORDER BY coalesce(r.score,0) DESC,ls.viewer_count DESC,ls.started_at DESC
    LIMIT greatest(1,least(coalesce(p_active_limit,80),200))
  ) SELECT coalesce(jsonb_agg(to_jsonb(active)),'[]'::jsonb),coalesce(jsonb_object_agg(id,score),'{}'::jsonb)
    INTO active_items,ranks FROM active;
  SELECT coalesce(jsonb_agg(to_jsonb(replay)),'[]'::jsonb) INTO replay_items FROM (
    SELECT ls.id,ls.title,ls.description,ls.thumbnail_url,ls.is_active,ls.viewer_count,ls.peak_viewer_count,
      ls.total_views,ls.category,ls.hashtags,ls.user_id,ls.recording_url,ls.started_at,ls.created_at,ls.ended_at
    FROM public.live_streams ls WHERE NOT ls.is_active AND ls.archive_expires_at > now() AND ls.recording_url IS NOT NULL
    ORDER BY ls.ended_at DESC LIMIT greatest(0,least(coalesce(p_replay_limit,30),100))
  ) replay;
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',pr.user_id,'name',pr.name,'avatar_url',pr.avatar_url)),'[]'::jsonb)
    INTO profiles FROM public.profiles pr WHERE pr.user_id IN (
      SELECT (item->>'user_id')::uuid FROM jsonb_array_elements(active_items || replay_items) item
    );
  RETURN jsonb_build_object('active',active_items,'replays',replay_items,'profiles',profiles,'ranks',ranks,'generated_at',extract(epoch FROM now()));
END $$;
REVOKE ALL ON FUNCTION public.live_feed_bundle(uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.live_feed_bundle(uuid,integer,integer) TO anon,authenticated;

-- Store this function's service credential in Vault during the Cloud release.
-- No credential is written into source code or cron.job.
CREATE OR REPLACE FUNCTION public.live_maintenance_cron_tick() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE credential text;
BEGIN
  SELECT decrypted_secret INTO credential FROM vault.decrypted_secrets
    WHERE name='live_maintenance_service_role_key' LIMIT 1;
  IF credential IS NULL THEN RAISE WARNING 'LIVE_MAINTENANCE_CREDENTIAL_MISSING'; RETURN; END IF;
  PERFORM net.http_post(url:='https://vkpmoqfzrihcijjochks.supabase.co/functions/v1/live-maintenance',
    headers:=jsonb_build_object('Authorization','Bearer '||credential,'Content-Type','application/json'),
    body:='{}'::jsonb,timeout_milliseconds:=10000);
END $$;
REVOKE ALL ON FUNCTION public.live_maintenance_cron_tick() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.live_maintenance_cron_tick() TO service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='live-maintenance') THEN PERFORM cron.unschedule('live-maintenance'); END IF;
    PERFORM cron.schedule('live-maintenance','* * * * *','SELECT public.live_maintenance_cron_tick()');
  ELSE RAISE EXCEPTION 'LIVE_MAINTENANCE_PG_CRON_REQUIRED'; END IF;
END $$;
COMMIT;
