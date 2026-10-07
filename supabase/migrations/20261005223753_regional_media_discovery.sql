BEGIN;

-- Only this account's city, only on explicit UI action; never expose a profile for location inference.
CREATE FUNCTION public.get_my_media_profile_city() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT left(trim(p.city),100) FROM public.profiles p WHERE p.user_id=(SELECT auth.uid());
$$;
REVOKE ALL ON FUNCTION public.get_my_media_profile_city() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_media_profile_city() TO authenticated;

CREATE FUNCTION public.media_place_key(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
 SELECT regexp_replace(translate(lower(coalesce(p_value,'')),
   'àâäáãåéèêëíìîïóòôöõúùûüçÿ','aaaaaaeeeeiiiiooooouuuucy'),'[^a-z0-9]','','g');
$$;
REVOKE ALL ON FUNCTION public.media_place_key(text) FROM PUBLIC,anon,authenticated;
-- Service ingestion maintains the expression index; ordinary clients cannot call this helper.
GRANT EXECUTE ON FUNCTION public.media_place_key(text) TO service_role;

CREATE INDEX media_partner_region ON public.media_partners(country,public.media_place_key(region)) WHERE active;
CREATE INDEX media_items_partner_recent ON public.partner_media_items(partner_id,published_at DESC,id) WHERE moderated;

CREATE OR REPLACE FUNCTION public.get_local_partner_media(p_scope text DEFAULT 'france',p_kind text DEFAULT 'all') RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='1500ms' AS $$
 WITH eligible AS (
   SELECT m.id,m.title,CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END excerpt,m.canonical_url,m.kind,
     CASE WHEN p.allow_youtube_embed THEN m.youtube_id END youtube_id,m.published_at,p.name source_name,
     p.country,p.region,p.city,p.website_host,
     CASE WHEN d.local_media AND p.country=d.country
       AND public.media_place_key(d.region)<>'' AND public.media_place_key(p.region)=public.media_place_key(d.region)
       THEN CASE WHEN public.media_place_key(d.city)<>'' AND public.media_place_key(p.city)=public.media_place_key(d.city) THEN 0 ELSE 1 END
       WHEN p.country='FR' AND public.media_place_key(p.region)='' AND public.media_place_key(p.city)='' THEN 2 ELSE 3 END proximity
   FROM public.partner_media_items m JOIN public.media_partners p ON p.id=m.partner_id
   LEFT JOIN public.discovery_preferences d ON d.user_id=(SELECT auth.uid())
   WHERE (SELECT auth.uid()) IS NOT NULL AND p_scope IN ('nearby','city','region','france') AND p_kind IN ('all','article','video')
     AND p.active AND p.rights_until>now() AND m.expires_at>now() AND m.published_at<=now() AND m.moderated
     AND (public.ad_adult_internal((SELECT auth.uid())) OR m.family_safe)
     AND (p_kind='all' OR m.kind=p_kind)
 ), deduplicated AS (
   SELECT *,row_number() OVER (PARTITION BY canonical_url ORDER BY proximity,published_at DESC,id) duplicate_number
   FROM eligible WHERE (p_scope='france' AND country='FR') OR (p_scope='nearby' AND proximity<=2)
     OR (p_scope='region' AND proximity<=1) OR (p_scope='city' AND proximity=0)
 ), diversified AS (
   SELECT *,row_number() OVER (PARTITION BY website_host ORDER BY proximity,published_at DESC,id) publisher_number
   FROM deduplicated WHERE duplicate_number=1
 ), selected AS (
   SELECT id,title,excerpt,canonical_url,kind,youtube_id,published_at,source_name,country,region,city,
     CASE proximity WHEN 0 THEN 'city' WHEN 1 THEN 'region' WHEN 2 THEN 'national' ELSE 'other' END proximity,
     row_number() OVER (ORDER BY CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,published_at DESC,id) position
   FROM diversified WHERE publisher_number<=4
   ORDER BY CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,published_at DESC,id LIMIT 12
 ) SELECT coalesce(jsonb_agg(to_jsonb(selected)-'position' ORDER BY position),'[]'::jsonb) FROM selected;
$$;
REVOKE ALL ON FUNCTION public.get_local_partner_media(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_local_partner_media(text,text) TO authenticated;

-- Return the edition geography: worker rejects mixing regional feeds in one national partner.
CREATE OR REPLACE FUNCTION public.claim_partner_rss_sources(p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' SET statement_timeout='5s' AS $$
DECLARE result jsonb;
BEGIN
 WITH due AS (
   SELECT s.id FROM public.partner_rss_sources s JOIN public.media_partners p ON p.id=s.partner_id
   WHERE s.enabled AND p.active AND p.rights_until>now() AND s.next_fetch_at<=now()
     AND (s.lease_until IS NULL OR s.lease_until<=now())
   ORDER BY s.next_fetch_at,s.id LIMIT least(20,greatest(1,coalesce(p_limit,20))) FOR UPDATE OF s SKIP LOCKED
 ), claimed AS (
   UPDATE public.partner_rss_sources s SET lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'
   FROM due WHERE s.id=due.id RETURNING s.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object(
   'id',c.id,'partner_id',c.partner_id,'source_key',c.source_key,'lease_token',c.lease_token,
   'website_host',p.website_host,'allow_excerpt',p.allow_excerpt,'rights_until',p.rights_until,
   'country',p.country,'region',p.region,'city',p.city,'etag',c.etag,'last_modified',c.last_modified
 )),'[]'::jsonb) INTO result FROM claimed c JOIN public.media_partners p ON p.id=c.partner_id;
 RETURN result;
END; $$;

-- Any edition/rights change invalidates in-flight jobs and conditional caches.
-- An old regional response must never be committed under a newly configured zone.
CREATE FUNCTION public.reset_partner_rss_after_partner_change() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 UPDATE public.partner_rss_sources SET etag=NULL,last_modified=NULL,next_fetch_at=now(),lease_token=NULL,lease_until=NULL
 WHERE partner_id=NEW.id;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.reset_partner_rss_after_partner_change() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER partner_rss_rights_or_zone_changed AFTER UPDATE OF website_host,country,region,city,active,rights_until,allow_excerpt
ON public.media_partners FOR EACH ROW EXECUTE FUNCTION public.reset_partner_rss_after_partner_change();

-- Poll the queue, not every publisher. Each source remains due about once per day.
CREATE FUNCTION public.get_partner_rss_coverage() RETURNS jsonb
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(coverage)),'[]'::jsonb) FROM (
   SELECT p.country,p.region,count(*) catalogued_sources,
     count(*) FILTER(WHERE s.enabled AND p.active AND p.rights_until>now()) authorized_sources,
     count(*) FILTER(WHERE s.enabled AND p.active AND p.rights_until>now() AND s.next_fetch_at<=now()) due_sources,
     count(*) FILTER(WHERE s.last_status='failure') failed_sources,
     max(s.last_success_at) last_success_at,
     (SELECT count(*) FROM public.partner_media_items m JOIN public.media_partners mp ON mp.id=m.partner_id
       WHERE mp.country=p.country AND mp.region IS NOT DISTINCT FROM p.region
         AND mp.active AND mp.rights_until>now() AND m.moderated AND m.expires_at>now() AND m.published_at<=now()) visible_items
   FROM public.partner_rss_sources s JOIN public.media_partners p ON p.id=s.partner_id
   GROUP BY p.country,p.region ORDER BY p.country,p.region
 ) coverage;
$$;
REVOKE ALL ON FUNCTION public.get_partner_rss_coverage() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_rss_coverage() TO service_role;

-- Poll the queue, not every publisher. Each source remains due about once per day.
-- Small hourly batches let >20 editions progress without a single huge worker run.
CREATE OR REPLACE FUNCTION private.partner_rss_daily_tick() RETURNS text
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE cron_secret text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.partner_rss_sources s JOIN public.media_partners p ON p.id=s.partner_id
   WHERE s.enabled AND p.active AND p.rights_until>now() AND s.next_fetch_at<=now()
   AND (s.lease_until IS NULL OR s.lease_until<=now())) THEN RETURN 'NO_DUE_SOURCES'; END IF;
 BEGIN
   SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets WHERE name='partner_rss_cron_secret' LIMIT 1;
 EXCEPTION WHEN undefined_table OR invalid_schema_name THEN RETURN 'SECRET_NOT_CONFIGURED'; END;
 IF cron_secret IS NULL OR length(cron_secret)<32 THEN RETURN 'SECRET_NOT_CONFIGURED'; END IF;
 PERFORM net.http_post(url:='https://vkpmoqfzrihcijjochks.supabase.co/functions/v1/partner-rss-sync',
   headers:=jsonb_build_object('Content-Type','application/json','x-media-cron-secret',cron_secret),
   body:='{}'::jsonb,timeout_milliseconds:=180000);
 RETURN 'DISPATCHED';
END; $$;
REVOKE ALL ON FUNCTION private.partner_rss_daily_tick() FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
   PERFORM cron.schedule('forsure-partner-rss-daily','7 * * * *','SELECT private.partner_rss_daily_tick()');
 ELSE RAISE WARNING 'Configure the RSS queue tick hourly in Lovable Cloud; each edition stays daily.';
 END IF;
END $$;
COMMIT;
