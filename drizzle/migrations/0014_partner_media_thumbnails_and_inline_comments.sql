ALTER TABLE public.partner_media_items
  ADD COLUMN IF NOT EXISTS thumbnail_url text;

ALTER TABLE public.partner_media_items
  DROP CONSTRAINT IF EXISTS partner_media_items_thumbnail_url_safe;
ALTER TABLE public.partner_media_items
  ADD CONSTRAINT partner_media_items_thumbnail_url_safe CHECK (
    thumbnail_url IS NULL OR (
      length(thumbnail_url) <= 2048
      AND thumbnail_url ~ '^https://'
      AND thumbnail_url !~ '[[:cntrl:]\\]'
      AND thumbnail_url !~ '^https://[^/]*@'
    )
  );

CREATE OR REPLACE FUNCTION public.enforce_partner_media_rights() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE partner public.media_partners;
BEGIN
 SELECT * INTO partner FROM public.media_partners WHERE id=NEW.partner_id;
 IF NOT coalesce(partner.active,false) OR partner.rights_until<=now() THEN RAISE EXCEPTION 'PARTNER_RIGHTS_REQUIRED'; END IF;
 IF NEW.canonical_url NOT LIKE 'https://'||partner.website_host||'/%' OR NEW.canonical_url ~ '[[:cntrl:]\\]' THEN RAISE EXCEPTION 'INVALID_PARTNER_URL'; END IF;
 IF NEW.excerpt<>'' AND NOT partner.allow_excerpt THEN RAISE EXCEPTION 'EXCERPT_RIGHTS_REQUIRED'; END IF;
 IF NEW.youtube_id IS NOT NULL AND (NOT partner.allow_youtube_embed OR NEW.kind<>'video') THEN RAISE EXCEPTION 'EMBED_RIGHTS_REQUIRED'; END IF;
 IF NEW.thumbnail_url IS NOT NULL AND (length(NEW.thumbnail_url)>2048 OR NEW.thumbnail_url !~ '^https://' OR NEW.thumbnail_url ~ '[[:cntrl:]\\]' OR NEW.thumbnail_url ~ '^https://[^/]*@')
 THEN RAISE EXCEPTION 'INVALID_THUMBNAIL_URL'; END IF;
 NEW.expires_at:=least(NEW.expires_at,partner.rights_until,NEW.published_at+interval '30 days');
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.import_partner_media(p_partner uuid,p_items jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; changed integer; total integer:=0;
BEGIN
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>50
 OR pg_column_size(p_items)>262144 THEN RAISE EXCEPTION 'INVALID_MEDIA_BATCH'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
   IF jsonb_typeof(item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k
     WHERE k NOT IN ('external_id','title','excerpt','canonical_url','kind','youtube_id','thumbnail_url','published_at','expires_at'))
     OR EXISTS(SELECT 1 FROM jsonb_each(item) x WHERE jsonb_typeof(x.value) NOT IN ('string','null'))
   THEN RAISE EXCEPTION 'INVALID_MEDIA_ITEM'; END IF;
   INSERT INTO public.partner_media_items(partner_id,external_id,title,excerpt,canonical_url,kind,youtube_id,thumbnail_url,published_at,expires_at)
   VALUES(p_partner,item->>'external_id',item->>'title',coalesce(item->>'excerpt',''),item->>'canonical_url',item->>'kind',item->>'youtube_id',item->>'thumbnail_url',
     (item->>'published_at')::timestamptz,(item->>'expires_at')::timestamptz)
   ON CONFLICT(partner_id,external_id) DO UPDATE SET
     moderated=CASE WHEN (public.partner_media_items.title,public.partner_media_items.excerpt,public.partner_media_items.canonical_url,public.partner_media_items.kind,
       public.partner_media_items.youtube_id,public.partner_media_items.published_at,public.partner_media_items.expires_at)
       IS NOT DISTINCT FROM (excluded.title,excluded.excerpt,excluded.canonical_url,excluded.kind,excluded.youtube_id,excluded.published_at,excluded.expires_at)
       THEN public.partner_media_items.moderated ELSE false END,
     family_safe=CASE WHEN (public.partner_media_items.title,public.partner_media_items.excerpt,public.partner_media_items.canonical_url,public.partner_media_items.kind,
       public.partner_media_items.youtube_id,public.partner_media_items.published_at,public.partner_media_items.expires_at)
       IS NOT DISTINCT FROM (excluded.title,excluded.excerpt,excluded.canonical_url,excluded.kind,excluded.youtube_id,excluded.published_at,excluded.expires_at)
       THEN public.partner_media_items.family_safe ELSE false END,
     title=excluded.title,excerpt=excluded.excerpt,canonical_url=excluded.canonical_url,kind=excluded.kind,youtube_id=excluded.youtube_id,
     thumbnail_url=excluded.thumbnail_url,published_at=excluded.published_at,expires_at=excluded.expires_at
   WHERE (public.partner_media_items.title,public.partner_media_items.excerpt,public.partner_media_items.canonical_url,public.partner_media_items.kind,
     public.partner_media_items.youtube_id,public.partner_media_items.thumbnail_url,public.partner_media_items.published_at,public.partner_media_items.expires_at)
     IS DISTINCT FROM (excluded.title,excluded.excerpt,excluded.canonical_url,excluded.kind,excluded.youtube_id,excluded.thumbnail_url,excluded.published_at,excluded.expires_at);
   GET DIAGNOSTICS changed=ROW_COUNT; total:=total+changed;
 END LOOP;
 RETURN total;
END; $$;
REVOKE ALL ON FUNCTION public.import_partner_media(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_partner_media(uuid,jsonb) TO service_role;

-- News discussions are a normal authenticated social feature, not an adult-ad feature.
CREATE OR REPLACE FUNCTION public.news_thread_readable(p_thread uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT p_user IS NOT NULL AND EXISTS(SELECT 1 FROM public.news_threads WHERE id=p_thread);
$$;
REVOKE ALL ON FUNCTION public.news_thread_readable(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_news_discussion(p_thread uuid,p_after_time timestamptz DEFAULT NULL,p_after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='1500ms' AS $$
DECLARE viewer uuid:=(SELECT auth.uid()); result jsonb; article jsonb; comments jsonb;
BEGIN
 IF NOT public.news_thread_readable(p_thread,viewer) THEN RETURN NULL; END IF;
 IF (p_after_time IS NULL)<>(p_after_id IS NULL) THEN RAISE EXCEPTION 'INVALID_CURSOR'; END IF;
 SELECT jsonb_build_object('id',t.id,'canonical_url',t.canonical_url,'source_name',t.source_name,'locked',t.locked)
 INTO result FROM public.news_threads t WHERE t.id=p_thread;
 SELECT jsonb_build_object('title',m.title,'excerpt',CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END,
   'published_at',m.published_at,'thumbnail_url',m.thumbnail_url,'kind',m.kind,
   'youtube_id',CASE WHEN p.allow_youtube_embed THEN m.youtube_id END)
 INTO article FROM public.partner_media_items m JOIN public.media_partners p ON p.id=m.partner_id
 WHERE m.discussion_id=p_thread AND m.moderated AND m.expires_at>now() AND m.published_at<=now()
   AND p.active AND p.rights_until>now()
 ORDER BY m.published_at DESC,m.id LIMIT 1;
 SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.created_at,c.id),'[]') INTO comments FROM (
   SELECT n.id,n.user_id,n.parent_id,CASE WHEN n.removed THEN '' ELSE n.body END body,n.created_at,n.removed
   FROM public.news_comments n LEFT JOIN public.news_comments parent ON parent.id=n.parent_id
   WHERE n.thread_id=p_thread AND public.news_users_unblocked(viewer,n.user_id)
     AND public.news_users_unblocked(viewer,parent.user_id)
     AND (p_after_time IS NULL OR (n.created_at,n.id)>(p_after_time,p_after_id))
   ORDER BY n.created_at,n.id LIMIT 51
 ) c;
 RETURN result||jsonb_build_object('article',article,'comments',comments);
END; $$;
REVOKE ALL ON FUNCTION public.get_news_discussion(uuid,timestamptz,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_news_discussion(uuid,timestamptz,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.partner_media_for_zone(p_scope text,p_kind text,p_country text,p_region text,p_city text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='1500ms' AS $$
 WITH eligible AS (
   SELECT m.id,m.discussion_id,m.title,CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END excerpt,m.canonical_url,m.kind,
     CASE WHEN p.allow_youtube_embed THEN m.youtube_id END youtube_id,m.thumbnail_url,m.published_at,p.name source_name,
     p.country,p.region,p.city,p.website_host,
     CASE WHEN p.country=p_country AND public.media_place_key(p_region)<>'' AND public.media_place_key(p.region)=public.media_place_key(p_region)
       THEN CASE WHEN public.media_place_key(p_city)<>'' AND public.media_place_key(p.city)=public.media_place_key(p_city) THEN 0 ELSE 1 END
       WHEN p.country='FR' AND public.media_place_key(p.region)='' AND public.media_place_key(p.city)='' THEN 2 ELSE 3 END proximity
   FROM public.partner_media_items m JOIN public.media_partners p ON p.id=m.partner_id
   WHERE (SELECT auth.uid()) IS NOT NULL AND p_scope IN ('nearby','city','region','france') AND p_kind IN ('all','article','video')
     AND p.active AND p.rights_until>now() AND m.expires_at>now() AND m.published_at<=now() AND m.moderated
     AND (p_kind='all' OR m.kind=p_kind)
 ), deduplicated AS (
   SELECT *,row_number() OVER (PARTITION BY canonical_url ORDER BY proximity,published_at DESC,id) duplicate_number
   FROM eligible WHERE (p_scope='france' AND country='FR') OR (p_scope='nearby' AND proximity<=2)
     OR (p_scope='region' AND proximity<=1) OR (p_scope='city' AND proximity=0)
 ), diversified AS (
   SELECT *,row_number() OVER (PARTITION BY website_host ORDER BY proximity,published_at DESC,id) publisher_number
   FROM deduplicated WHERE duplicate_number=1
 ), selected AS (
   SELECT id,discussion_id,title,excerpt,canonical_url,kind,youtube_id,thumbnail_url,published_at,source_name,country,region,city,
     CASE proximity WHEN 0 THEN 'city' WHEN 1 THEN 'region' WHEN 2 THEN 'national' ELSE 'other' END proximity,
     row_number() OVER (ORDER BY CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,published_at DESC,id) position
   FROM diversified WHERE publisher_number<=4
   ORDER BY CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,published_at DESC,id LIMIT 12
 ) SELECT coalesce(jsonb_agg(to_jsonb(selected)-'position' ORDER BY position),'[]'::jsonb) FROM selected;
$$;
REVOKE ALL ON FUNCTION public.partner_media_for_zone(text,text,text,text,text) FROM PUBLIC,anon,authenticated;