CREATE TABLE public.news_threads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_url text UNIQUE NOT NULL,
 source_name text NOT NULL, locked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.partner_media_items ADD COLUMN discussion_id uuid REFERENCES public.news_threads(id);
CREATE INDEX partner_media_discussion ON public.partner_media_items(discussion_id) WHERE moderated;
CREATE TABLE public.news_comments (
 id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES public.news_threads(id) ON DELETE CASCADE,
 user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 parent_id uuid REFERENCES public.news_comments(id), body text NOT NULL CHECK(length(body)<=1000),
 created_at timestamptz NOT NULL DEFAULT now(), removed boolean NOT NULL DEFAULT false
);
CREATE INDEX news_comments_page ON public.news_comments(thread_id,created_at,id);
CREATE INDEX news_comments_parent ON public.news_comments(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX news_comments_author ON public.news_comments(user_id);
CREATE TABLE public.news_comment_limits (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, last_sent timestamptz NOT NULL);
CREATE TABLE public.news_comment_reports (
 comment_id uuid NOT NULL REFERENCES public.news_comments(id) ON DELETE CASCADE,
 reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(comment_id,reporter_id)
);
CREATE INDEX news_reports_reporter ON public.news_comment_reports(reporter_id,created_at DESC);
ALTER TABLE public.news_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_comment_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_comment_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.news_threads,public.news_comments,public.news_comment_limits,public.news_comment_reports FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.news_threads,public.news_comments,public.news_comment_limits,public.news_comment_reports TO service_role;
CREATE POLICY news_threads_service ON public.news_threads TO service_role USING(true) WITH CHECK(true);
CREATE POLICY news_comments_service ON public.news_comments TO service_role USING(true) WITH CHECK(true);
CREATE POLICY news_limits_service ON public.news_comment_limits TO service_role USING(true) WITH CHECK(true);
CREATE POLICY news_reports_service ON public.news_comment_reports TO service_role USING(true) WITH CHECK(true);

CREATE FUNCTION public.redact_news_deleted_account() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN NEW.body:=''; NEW.removed:=true; END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.redact_news_deleted_account() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER redact_news_deleted_account BEFORE UPDATE OF user_id ON public.news_comments
FOR EACH ROW EXECUTE FUNCTION public.redact_news_deleted_account();

CREATE FUNCTION public.attach_news_discussion() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE tid uuid;
BEGIN
 IF NEW.moderated THEN
   INSERT INTO public.news_threads(canonical_url,source_name)
     SELECT NEW.canonical_url,p.name FROM public.media_partners p WHERE p.id=NEW.partner_id
     ON CONFLICT(canonical_url) DO NOTHING;
   SELECT id INTO tid FROM public.news_threads WHERE canonical_url=NEW.canonical_url;
   NEW.discussion_id:=tid;
 ELSE NEW.discussion_id:=NULL;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.attach_news_discussion() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER attach_news_discussion BEFORE INSERT OR UPDATE OF moderated,canonical_url,discussion_id
ON public.partner_media_items FOR EACH ROW EXECUTE FUNCTION public.attach_news_discussion();
UPDATE public.partner_media_items m SET moderated=m.moderated FROM public.media_partners p
WHERE p.id=m.partner_id AND m.moderated AND m.expires_at>now() AND p.active AND p.rights_until>now();

CREATE FUNCTION public.news_thread_readable(p_thread uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT p_user IS NOT NULL AND EXISTS(SELECT 1 FROM public.news_threads WHERE id=p_thread)
 AND (public.ad_adult_internal(p_user) OR EXISTS(
   SELECT 1 FROM public.partner_media_items m JOIN public.media_partners p ON p.id=m.partner_id
   WHERE m.discussion_id=p_thread AND m.moderated AND m.family_safe AND m.published_at<=now()
     AND m.expires_at>now() AND p.active AND p.rights_until>now()));
$$;
CREATE FUNCTION public.news_users_unblocked(p_user uuid,p_other uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.user_message_blocks b
  WHERE (b.blocker_user_id=p_user AND b.blocked_user_id=p_other)
     OR (b.blocker_user_id=p_other AND b.blocked_user_id=p_user));
$$;
REVOKE ALL ON FUNCTION public.news_thread_readable(uuid,uuid),public.news_users_unblocked(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.get_news_discussion(p_thread uuid,p_after_time timestamptz DEFAULT NULL,p_after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='1500ms' AS $$
DECLARE viewer uuid:=(SELECT auth.uid()); result jsonb; article jsonb; comments jsonb;
BEGIN
 IF NOT public.news_thread_readable(p_thread,viewer) THEN RETURN NULL; END IF;
 IF (p_after_time IS NULL)<>(p_after_id IS NULL) THEN RAISE EXCEPTION 'INVALID_CURSOR'; END IF;
 SELECT jsonb_build_object('id',t.id,'canonical_url',t.canonical_url,'source_name',t.source_name,'locked',t.locked)
 INTO result FROM public.news_threads t WHERE t.id=p_thread;
 SELECT jsonb_build_object('title',m.title,'excerpt',CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END,'published_at',m.published_at)
 INTO article FROM public.partner_media_items m JOIN public.media_partners p ON p.id=m.partner_id
 WHERE m.discussion_id=p_thread AND m.moderated AND m.expires_at>now() AND m.published_at<=now()
   AND p.active AND p.rights_until>now() AND (public.ad_adult_internal(viewer) OR m.family_safe)
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

CREATE FUNCTION public.add_news_comment(p_thread uuid,p_id uuid,p_body text,p_parent uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='3s' AS $$
DECLARE viewer uuid:=(SELECT auth.uid()); clean_body text:=btrim(p_body); old public.news_comments; parent public.news_comments; previous timestamptz;
BEGIN
 IF viewer IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
 PERFORM 1 FROM public.news_threads WHERE id=p_thread FOR SHARE;
 IF NOT public.news_thread_readable(p_thread,viewer) OR (SELECT locked FROM public.news_threads WHERE id=p_thread)
 THEN RAISE EXCEPTION 'DISCUSSION_UNAVAILABLE'; END IF;
 IF p_id IS NULL OR clean_body IS NULL OR length(clean_body)<1 OR length(clean_body)>1000
 THEN RAISE EXCEPTION 'INVALID_COMMENT'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('news-comment:'||viewer::text,0));
 SELECT * INTO old FROM public.news_comments WHERE id=p_id;
 IF FOUND THEN
   IF old.user_id=viewer AND old.thread_id=p_thread AND old.parent_id IS NOT DISTINCT FROM p_parent AND old.body=clean_body AND NOT old.removed
   THEN RETURN old.id; END IF;
   RAISE EXCEPTION 'COMMENT_CONFLICT';
 END IF;
 IF p_parent IS NOT NULL THEN
   SELECT * INTO parent FROM public.news_comments WHERE id=p_parent AND thread_id=p_thread AND parent_id IS NULL AND NOT removed FOR SHARE;
   IF NOT FOUND OR NOT public.news_users_unblocked(viewer,parent.user_id) THEN RAISE EXCEPTION 'REPLY_UNAVAILABLE'; END IF;
 END IF;
 SELECT last_sent INTO previous FROM public.news_comment_limits WHERE user_id=viewer;
 IF previous>now()-interval '3 seconds' THEN RAISE EXCEPTION 'COMMENT_RATE_LIMITED'; END IF;
 INSERT INTO public.news_comment_limits VALUES(viewer,now()) ON CONFLICT(user_id) DO UPDATE SET last_sent=excluded.last_sent;
 INSERT INTO public.news_comments(id,thread_id,user_id,parent_id,body) VALUES(p_id,p_thread,viewer,p_parent,clean_body);
 RETURN p_id;
END; $$;

CREATE FUNCTION public.remove_news_comment(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF (SELECT auth.uid()) IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
 UPDATE public.news_comments SET body='',removed=true WHERE id=p_id AND user_id=(SELECT auth.uid());
 RETURN FOUND;
END; $$;

CREATE FUNCTION public.report_news_comment(p_id uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE viewer uuid:=(SELECT auth.uid()); comment public.news_comments;
BEGIN
 IF viewer IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
 IF p_reason IS NULL OR p_reason NOT IN ('spam','harassment','other') THEN RAISE EXCEPTION 'INVALID_REASON'; END IF;
 SELECT * INTO comment FROM public.news_comments WHERE id=p_id AND NOT removed;
 IF NOT FOUND OR comment.user_id IS NULL OR comment.user_id=viewer
   OR NOT public.news_thread_readable(comment.thread_id,viewer)
   OR NOT public.news_users_unblocked(viewer,comment.user_id) THEN RAISE EXCEPTION 'COMMENT_UNAVAILABLE'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('news-report:'||viewer::text,0));
 IF EXISTS(SELECT 1 FROM public.news_comment_reports WHERE comment_id=p_id AND reporter_id=viewer) THEN RETURN false; END IF;
 IF (SELECT count(*) FROM public.news_comment_reports WHERE reporter_id=viewer AND created_at>now()-interval '1 hour')>=20
 THEN RAISE EXCEPTION 'REPORT_RATE_LIMITED'; END IF;
 INSERT INTO public.news_comment_reports(comment_id,reporter_id) VALUES(p_id,viewer) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO public.abuse_reports(reporter_id,reported_user_id,report_type,description,evidence_urls)
 VALUES(viewer,comment.user_id,p_reason,'Discussion actualité — commentaire '||p_id::text||E'\n'||comment.body,
   ARRAY['https://forsure.fans/news/'||comment.thread_id::text||'#comment-'||p_id::text]);
 RETURN true;
END; $$;

CREATE FUNCTION public.moderate_news_comment(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT coalesce(public.has_role((SELECT auth.uid()),'admin'),false) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 UPDATE public.news_comments SET body='',removed=true WHERE id=p_id;
 RETURN FOUND;
END; $$;
REVOKE ALL ON FUNCTION public.get_news_discussion(uuid,timestamptz,uuid),public.add_news_comment(uuid,uuid,text,uuid),
 public.remove_news_comment(uuid),public.report_news_comment(uuid,text),public.moderate_news_comment(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_news_discussion(uuid,timestamptz,uuid),public.add_news_comment(uuid,uuid,text,uuid),
 public.remove_news_comment(uuid),public.report_news_comment(uuid,text),public.moderate_news_comment(uuid) TO authenticated;

CREATE FUNCTION public.partner_media_for_zone(p_scope text,p_kind text,p_country text,p_region text,p_city text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path='' AS $$
 WITH eligible AS (
   SELECT m.id,m.discussion_id,m.title,CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END excerpt,m.canonical_url,m.kind,
     CASE WHEN p.allow_youtube_embed THEN m.youtube_id END youtube_id,m.published_at,p.name source_name,
     p.country,p.region,p.city,p.website_host,
     CASE WHEN p.country=p_country AND public.media_place_key(p_region)<>''
       AND public.media_place_key(p.region)=public.media_place_key(p_region)
       THEN CASE WHEN public.media_place_key(p_city)<>'' AND public.media_place_key(p.city)=public.media_place_key(p_city) THEN 0 ELSE 1 END
       WHEN p.country='FR' AND public.media_place_key(p.region)='' AND public.media_place_key(p.city)='' THEN 2 ELSE 3 END proximity
   FROM public.partner_media_items m JOIN public.media_partners p ON p.id=m.partner_id
   WHERE (SELECT auth.uid()) IS NOT NULL AND p_scope IN ('nearby','city','region','france') AND p_kind IN ('all','article','video')
     AND p.active AND p.rights_until>now() AND m.expires_at>now() AND m.published_at<=now() AND m.moderated
     AND (public.ad_adult_internal((SELECT auth.uid())) OR m.family_safe) AND (p_kind='all' OR m.kind=p_kind)
 ), deduplicated AS (
   SELECT *,row_number() OVER (PARTITION BY canonical_url ORDER BY proximity,published_at DESC,id) duplicate_number
   FROM eligible WHERE (p_scope='france' AND country='FR') OR (p_scope='nearby' AND proximity<=2)
     OR (p_scope='region' AND proximity<=1) OR (p_scope='city' AND proximity=0)
 ), diversified AS (
   SELECT *,row_number() OVER (PARTITION BY website_host ORDER BY proximity,published_at DESC,id) publisher_number
   FROM deduplicated WHERE duplicate_number=1
 ), selected AS (
   SELECT id,discussion_id,title,excerpt,canonical_url,kind,youtube_id,published_at,source_name,country,region,city,
     CASE proximity WHEN 0 THEN 'city' WHEN 1 THEN 'region' WHEN 2 THEN 'national' ELSE 'other' END proximity,
     row_number() OVER (ORDER BY CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,published_at DESC,id) position
   FROM diversified WHERE publisher_number<=4
   ORDER BY CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,published_at DESC,id LIMIT 12
 ) SELECT coalesce(jsonb_agg(to_jsonb(selected)-'position' ORDER BY position),'[]'::jsonb) FROM selected;
$$;
REVOKE ALL ON FUNCTION public.partner_media_for_zone(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.get_local_partner_media(p_scope text DEFAULT 'france',p_kind text DEFAULT 'all') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='1500ms' AS $$
DECLARE d public.discovery_preferences;
BEGIN
 SELECT * INTO d FROM public.discovery_preferences WHERE user_id=(SELECT auth.uid()) AND local_media;
 RETURN public.partner_media_for_zone(p_scope,p_kind,d.country,d.region,d.city);
END; $$;
CREATE FUNCTION public.get_contextual_partner_media(p_scope text,p_kind text,p_country text,p_region text,p_city text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='1500ms' AS $$
DECLARE d public.discovery_preferences;
BEGIN
 SELECT * INTO d FROM public.discovery_preferences WHERE user_id=(SELECT auth.uid());
 IF FOUND THEN
   IF NOT d.local_media THEN RETURN public.partner_media_for_zone(p_scope,p_kind,NULL,NULL,NULL); END IF;
   IF nullif(d.region,'') IS NOT NULL THEN RETURN public.partner_media_for_zone(p_scope,p_kind,d.country,d.region,d.city); END IF;
 END IF;
 IF p_country IS DISTINCT FROM 'FR' OR length(coalesce(p_region,''))>100 OR length(coalesce(p_city,''))>100
 THEN RETURN public.partner_media_for_zone(p_scope,p_kind,NULL,NULL,NULL); END IF;
 RETURN public.partner_media_for_zone(p_scope,p_kind,p_country,p_region,p_city);
END; $$;
REVOKE ALL ON FUNCTION public.get_contextual_partner_media(text,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_contextual_partner_media(text,text,text,text,text) TO authenticated;