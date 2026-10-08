BEGIN;

-- A trusted RSS refresh may legitimately update a title, canonical URL or
-- expiry. import_partner_media deliberately resets moderation in that case.
-- Remember which existing rows were approved before the refresh so they can
-- remain visible, while a row already rejected by a human stays rejected.
CREATE OR REPLACE FUNCTION public.finish_partner_rss_import(
 p_source uuid,p_lease uuid,p_items jsonb,p_status text,p_etag text DEFAULT NULL,p_modified text DEFAULT NULL,p_error text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SET search_path='' SET statement_timeout='10s' AS $$
DECLARE
 s public.partner_rss_sources;
 p public.media_partners;
 fresh_ids text[];
 previously_approved_ids text[];
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
     coalesce(i->>'kind','') NOT IN ('article','video') OR coalesce(i->>'external_id','') !~ '^rss:[a-f0-9]{64}$'
     OR i->>'published_at' IS NULL OR i->>'expires_at' IS NULL
     OR (i->>'published_at')::timestamptz>now() OR (i->>'expires_at')::timestamptz<=now()
     OR (i->>'youtube_id' IS NOT NULL AND (
       i->>'kind'<>'video' OR i->>'youtube_id' !~ '^[A-Za-z0-9_-]{11}$' OR NOT p.allow_youtube_embed
     )))
   THEN RAISE EXCEPTION 'INVALID_RSS_ITEM'; END IF;

   SELECT coalesce(array_agg(i->>'external_id'),'{}') INTO fresh_ids
   FROM jsonb_array_elements(p_items) i
   WHERE NOT EXISTS(
     SELECT 1 FROM public.partner_media_items m
     WHERE m.partner_id=s.partner_id AND m.external_id=i->>'external_id'
   );

   SELECT coalesce(array_agg(m.external_id),'{}') INTO previously_approved_ids
   FROM public.partner_media_items m
   JOIN jsonb_array_elements(p_items) i ON i->>'external_id'=m.external_id
   WHERE m.partner_id=s.partner_id AND m.moderated;

   PERFORM public.import_partner_media(s.partner_id,p_items);
   IF s.auto_publish THEN
     UPDATE public.partner_media_items SET moderated=true
     WHERE partner_id=s.partner_id
       AND (external_id=ANY(fresh_ids) OR external_id=ANY(previously_approved_ids));
     -- family_safe stays false: trusted news is not automatically suitable for minors.
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

-- One-time recovery for active RSS rows hidden by the previous refresh logic.
-- The schema predates moderation provenance, so this is deliberately restricted
-- to cryptographically-shaped RSS identifiers owned by enabled auto-publish feeds.
UPDATE public.partner_media_items AS item
SET moderated=true
FROM public.media_partners AS partner
WHERE item.partner_id=partner.id
  AND item.moderated=false
  AND item.external_id ~ '^rss:[a-f0-9]{64}$'
  AND item.published_at<=now()
  AND item.expires_at>now()
  AND partner.active
  AND partner.rights_until>now()
  AND EXISTS(
    SELECT 1 FROM public.partner_rss_sources AS source
    WHERE source.partner_id=item.partner_id
      AND source.enabled
      AND source.auto_publish
  );

-- A worker claims at most 20 sources. An hourly due-source drain handles every
-- configured newspaper even as the catalogue grows; next_fetch_at still limits
-- each source to approximately one fetch per day.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')
    AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
   IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='forsure-partner-rss-daily') THEN
     PERFORM cron.unschedule('forsure-partner-rss-daily');
   END IF;
   IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='forsure-partner-rss-hourly') THEN
     PERFORM cron.unschedule('forsure-partner-rss-hourly');
   END IF;
   PERFORM cron.schedule(
     'forsure-partner-rss-hourly',
     '17 * * * *',
     'SELECT private.partner_rss_daily_tick()'
   );
 ELSE
   RAISE WARNING 'RSS hourly job not installed: pg_cron and pg_net are required.';
 END IF;
END $$;

UPDATE public.partner_rss_sources
SET next_fetch_at=now(),lease_token=NULL,lease_until=NULL
WHERE enabled;

-- Enqueue the first batch immediately; the hourly drain will collect the rest.
SELECT private.partner_rss_daily_tick();

COMMIT;

