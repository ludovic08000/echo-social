BEGIN;

-- Private operator configuration: no actual publisher rights are assumed or seeded.
CREATE TABLE public.partner_rss_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 partner_id uuid NOT NULL REFERENCES public.media_partners(id) ON DELETE CASCADE,
 source_key text NOT NULL CHECK(source_key ~ '^[a-z][a-z0-9-]{0,79}$'),
 enabled boolean NOT NULL DEFAULT false,
 auto_publish boolean NOT NULL DEFAULT false,
 etag text CHECK(length(etag)<=256), last_modified text CHECK(length(last_modified)<=256),
 next_fetch_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz,
 last_checked_at timestamptz, last_success_at timestamptz,
 last_status text CHECK(last_status IN ('success','not_modified','failure','disabled')),
 last_error text CHECK(length(last_error)<=80), last_items integer NOT NULL DEFAULT 0,
 UNIQUE(partner_id,source_key)
);
CREATE INDEX partner_rss_due ON public.partner_rss_sources(next_fetch_at,id) WHERE enabled;
ALTER TABLE public.partner_rss_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_rss_sources FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.partner_rss_sources TO service_role;

CREATE FUNCTION public.reset_partner_rss_configuration() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 NEW.etag:=NULL; NEW.last_modified:=NULL; NEW.next_fetch_at:=now();
 NEW.lease_token:=NULL; NEW.lease_until:=NULL;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.reset_partner_rss_configuration() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER rss_configuration_changed BEFORE UPDATE OF partner_id,source_key,enabled,auto_publish
ON public.partner_rss_sources FOR EACH ROW EXECUTE FUNCTION public.reset_partner_rss_configuration();

-- Invoker privileges, service-only; row leases prevent duplicate concurrent runs.
CREATE FUNCTION public.claim_partner_rss_sources(p_limit integer DEFAULT 20) RETURNS jsonb
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
   'etag',c.etag,'last_modified',c.last_modified
 )),'[]'::jsonb) INTO result FROM claimed c JOIN public.media_partners p ON p.id=c.partner_id;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.claim_partner_rss_sources(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_partner_rss_sources(integer) TO service_role;

CREATE FUNCTION public.finish_partner_rss_import(
 p_source uuid,p_lease uuid,p_items jsonb,p_status text,p_etag text DEFAULT NULL,p_modified text DEFAULT NULL,p_error text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SET search_path='' SET statement_timeout='10s' AS $$
DECLARE s public.partner_rss_sources; p public.media_partners; fresh_ids text[];
BEGIN
 SELECT * INTO s FROM public.partner_rss_sources WHERE id=p_source FOR UPDATE;
 IF NOT FOUND OR p_lease IS NULL OR s.lease_token IS DISTINCT FROM p_lease OR s.lease_until<=now() THEN RETURN false; END IF;
 SELECT * INTO p FROM public.media_partners WHERE id=s.partner_id FOR UPDATE;
 IF NOT s.enabled OR NOT p.active OR p.rights_until<=now() THEN
   UPDATE public.partner_rss_sources SET lease_token=NULL,lease_until=NULL,last_status='disabled',last_checked_at=now()
   WHERE id=s.id; RETURN false;
 END IF;
 IF p_status IS NULL OR p_status NOT IN ('success','not_modified','failure')
 OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>50 OR pg_column_size(p_items)>262144
 OR (p_status<>'success' AND p_items<>'[]'::jsonb)
 OR length(p_etag)>256 OR length(p_modified)>256 OR p_etag ~ '[[:cntrl:]]' OR p_modified ~ '[[:cntrl:]]'
 OR (p_error IS NOT NULL AND p_error !~ '^[A-Z_]{1,80}$')
 THEN RAISE EXCEPTION 'INVALID_RSS_RESULT'; END IF;
 IF p_status='not_modified' AND s.etag IS NULL AND s.last_modified IS NULL THEN RAISE EXCEPTION 'INVALID_RSS_NOT_MODIFIED'; END IF;
 IF p_status='success' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) i WHERE
     i->>'kind' IS DISTINCT FROM 'article' OR i->>'external_id' !~ '^rss:[a-f0-9]{64}$'
     OR (i->>'published_at')::timestamptz>now() OR (i->>'expires_at')::timestamptz<=now())
   THEN RAISE EXCEPTION 'INVALID_RSS_ITEM'; END IF;
   -- Never undo a human rejection or silently approve an edited, previously reviewed item.
   SELECT coalesce(array_agg(i->>'external_id'),'{}') INTO fresh_ids FROM jsonb_array_elements(p_items) i
   WHERE NOT EXISTS(SELECT 1 FROM public.partner_media_items m WHERE m.partner_id=s.partner_id AND m.external_id=i->>'external_id');
   PERFORM public.import_partner_media(s.partner_id,p_items);
   IF s.auto_publish THEN
     UPDATE public.partner_media_items SET moderated=true
     WHERE partner_id=s.partner_id AND external_id=ANY(fresh_ids);
     -- family_safe stays false: a trusted publisher is not automatically suitable for minors.
   END IF;
 END IF;
 UPDATE public.partner_rss_sources SET
   lease_token=NULL,lease_until=NULL,next_fetch_at=now()+interval '23 hours',
   last_checked_at=now(),last_status=p_status,last_items=jsonb_array_length(p_items),
   last_error=CASE WHEN p_status='failure' THEN coalesce(p_error,'FETCH_FAILED') END,
   last_success_at=CASE WHEN p_status<>'failure' THEN now() ELSE last_success_at END,
   etag=CASE WHEN p_status='failure' THEN etag ELSE p_etag END,
   last_modified=CASE WHEN p_status='failure' THEN last_modified ELSE p_modified END
 WHERE id=s.id;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.finish_partner_rss_import(uuid,uuid,jsonb,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_partner_rss_import(uuid,uuid,jsonb,text,text,text,text) TO service_role;

-- Lovable Cloud daily job. No service-role secret in the scheduler, browser or source code.
CREATE SCHEMA IF NOT EXISTS private;
CREATE FUNCTION private.partner_rss_daily_tick() RETURNS text
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE cron_secret text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.partner_rss_sources s JOIN public.media_partners p ON p.id=s.partner_id
   WHERE s.enabled AND p.active AND p.rights_until>now()) THEN RETURN 'NO_ENABLED_SOURCES'; END IF;
 BEGIN
   SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets WHERE name='partner_rss_cron_secret' LIMIT 1;
 EXCEPTION WHEN undefined_table OR invalid_schema_name THEN RETURN 'SECRET_NOT_CONFIGURED'; END;
 IF cron_secret IS NULL OR length(cron_secret)<32 THEN RETURN 'SECRET_NOT_CONFIGURED'; END IF;
 PERFORM net.http_post(
   url:='https://vkpmoqfzrihcijjochks.supabase.co/functions/v1/partner-rss-sync',
   headers:=jsonb_build_object('Content-Type','application/json','x-media-cron-secret',cron_secret),
   body:='{}'::jsonb,timeout_milliseconds:=180000
 );
 RETURN 'DISPATCHED';
END; $$;
REVOKE ALL ON FUNCTION private.partner_rss_daily_tick() FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
   PERFORM cron.schedule('forsure-partner-rss-daily','0 5 * * *','SELECT private.partner_rss_daily_tick()');
 ELSE RAISE WARNING 'RSS daily job not installed: enable Cron/pg_net in the existing Lovable Cloud backend, then schedule private.partner_rss_daily_tick at 05:00 UTC.';
 END IF;
END $$;
COMMIT;
