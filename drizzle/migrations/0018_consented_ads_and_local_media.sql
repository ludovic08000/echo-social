-- lovable-cron-fallback-reviewed: committed migration requires 15-minute expiry of consent-scoped ad audience cache and expired partner media rights
CREATE TABLE public.discovery_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  ads_profile boolean NOT NULL DEFAULT false,
  ads_activity boolean NOT NULL DEFAULT false,
  ads_location boolean NOT NULL DEFAULT false,
  local_media boolean NOT NULL DEFAULT false,
  country text, region text, city text,
  activity_since timestamptz,
  consent_revision text NOT NULL DEFAULT 'ads-local-2026-10',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  CHECK (length(region)<=100 AND length(city)<=100),
  CHECK (local_media OR (country IS NULL AND region IS NULL AND city IS NULL))
);
ALTER TABLE public.discovery_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discovery_preferences FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.discovery_preferences TO authenticated;
GRANT ALL ON public.discovery_preferences TO service_role;
CREATE POLICY discovery_owner_read ON public.discovery_preferences FOR SELECT TO authenticated USING ((SELECT auth.uid())=user_id);

CREATE TABLE public.ad_audience_cache (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  topics text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ad_audience_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_audience_cache FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.ad_audience_cache TO service_role;
CREATE TABLE public.ad_audience_sources (
 user_id uuid NOT NULL REFERENCES public.ad_audience_cache(user_id) ON DELETE CASCADE,
 author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,author_id)
);
CREATE INDEX ad_audience_sources_author ON public.ad_audience_sources(author_id,user_id);
ALTER TABLE public.ad_audience_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_audience_sources FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.ad_audience_sources TO service_role;

CREATE FUNCTION public.ad_adult_internal(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=p_user
   AND p.date_of_birth<=current_date-interval '18 years')
 AND NOT EXISTS(SELECT 1 FROM public.parental_controls c WHERE c.user_id=p_user AND c.is_minor=true);
$$;
REVOKE ALL ON FUNCTION public.ad_adult_internal(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.ad_topic_internal(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE lower(trim(p_text))
 WHEN 'sport' THEN 'Sport' WHEN 'sports' THEN 'Sport'
 WHEN 'tech' THEN 'Tech' WHEN 'technologie' THEN 'Tech'
 WHEN 'cuisine' THEN 'Cuisine' WHEN 'cooking' THEN 'Cuisine'
 WHEN 'musique' THEN 'Musique' WHEN 'music' THEN 'Musique'
 WHEN 'art' THEN 'Art' WHEN 'arts' THEN 'Art'
 WHEN 'gaming' THEN 'Gaming' WHEN 'jeux vidéo' THEN 'Gaming'
 WHEN 'jardinage' THEN 'Jardinage' WHEN 'bricolage' THEN 'Bricolage' END;
$$;
REVOKE ALL ON FUNCTION public.ad_topic_internal(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.ad_text_topics_internal(p_text text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE t text:=lower(left(coalesce(p_text,''),3000)); result text[]:='{}';
BEGIN
 IF t ~ '(santé|sante|malad|cancer|diabèt|diabet|dépress|depress|handicap|grossess|enceinte|relig|musulman|juif|juive|chrét|chret|catholi|politique|élection|election|syndica|sexu|homosex|lesbien|transgenre|racis|ethni|origine|réfugi|refugi|dette|chômag|chomag|pauvret|addict|thérap|therap|médic|medic|suicid|déteste|deteste|hate|pas |jamais |contre )' THEN RETURN result; END IF;
 IF t ~ '\m(football|basket|tennis|rugby|volley|sport)\M' THEN result:=array_append(result,'Sport'); END IF;
 IF t ~ '\m(informatique|programmation|ordinateur|robotique|tech)\M' THEN result:=array_append(result,'Tech'); END IF;
 IF t ~ '\m(recette|pâtisserie|patisserie|cuisine)\M' THEN result:=array_append(result,'Cuisine'); END IF;
 IF t ~ '\m(guitare|piano|concert|musique)\M' THEN result:=array_append(result,'Musique'); END IF;
 IF t ~ '\m(dessin|peinture|sculpture|aquarelle)\M' THEN result:=array_append(result,'Art'); END IF;
 IF t ~ '\m(gaming|console|minecraft)\M' THEN result:=array_append(result,'Gaming'); END IF;
 IF t ~ '\m(jardinage|potager|horticulture)\M' THEN result:=array_append(result,'Jardinage'); END IF;
 IF t ~ '\m(bricolage|menuiserie|ébénisterie)\M' THEN result:=array_append(result,'Bricolage'); END IF;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.ad_text_topics_internal(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.set_discovery_preferences(p_preferences jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=auth.uid(); previous public.discovery_preferences; saved public.discovery_preferences;
 a boolean; b boolean; c boolean; l boolean;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_preferences) IS DISTINCT FROM 'object' OR pg_column_size(p_preferences)>2048
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_preferences) k WHERE k NOT IN ('ads_profile','ads_activity','ads_location','local_media','country','region','city'))
 OR EXISTS(SELECT 1 FROM jsonb_each(p_preferences) x WHERE x.key IN ('ads_profile','ads_activity','ads_location','local_media') AND jsonb_typeof(x.value)<>'boolean')
 OR EXISTS(SELECT 1 FROM jsonb_each(p_preferences) x WHERE x.key IN ('country','region','city') AND jsonb_typeof(x.value) NOT IN ('string','null'))
 THEN RAISE EXCEPTION 'INVALID_PREFERENCES' USING ERRCODE='22023'; END IF;
 a:=coalesce((p_preferences->>'ads_profile')::boolean,false);
 b:=coalesce((p_preferences->>'ads_activity')::boolean,false);
 c:=coalesce((p_preferences->>'ads_location')::boolean,false);
 l:=coalesce((p_preferences->>'local_media')::boolean,false);
 IF (a OR b OR c) AND NOT public.ad_adult_internal(u) THEN RAISE EXCEPTION 'ADULT_ONLY' USING ERRCODE='42501'; END IF;
 INSERT INTO public.discovery_preferences(user_id) VALUES(u) ON CONFLICT DO NOTHING;
 SELECT * INTO previous FROM public.discovery_preferences WHERE user_id=u FOR UPDATE;
 UPDATE public.discovery_preferences SET ads_profile=a,ads_activity=b,ads_location=c AND l,local_media=l,
 country=CASE WHEN l THEN nullif(upper(trim(p_preferences->>'country')),'') END,
 region=CASE WHEN l THEN nullif(trim(p_preferences->>'region'),'') END,
 city=CASE WHEN l THEN nullif(trim(p_preferences->>'city'),'') END,
 activity_since=CASE WHEN b THEN CASE WHEN previous.ads_activity THEN previous.activity_since ELSE now() END END,
 updated_at=now() WHERE user_id=u RETURNING * INTO saved;
 DELETE FROM public.ad_audience_cache WHERE user_id=u;
 RETURN to_jsonb(saved);
END; $$;
REVOKE ALL ON FUNCTION public.set_discovery_preferences(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_discovery_preferences(jsonb) TO authenticated;

CREATE INDEX IF NOT EXISTS comments_ad_owner_recent ON public.comments(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS posts_ad_owner_recent ON public.posts(user_id,created_at DESC);

CREATE FUNCTION public.refresh_my_ad_audience() RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='1500ms' AS $$
DECLARE u uuid:=auth.uid(); pref public.discovery_preferences; cutoff timestamptz; result text[]; authors uuid[];
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO pref FROM public.discovery_preferences WHERE user_id=u FOR UPDATE;
 IF NOT coalesce(pref.ads_activity,false) OR NOT public.ad_adult_internal(u)
 OR NOT EXISTS(SELECT 1 FROM public.privacy_settings p WHERE p.user_id=u
   AND p.analytics_enabled=true AND p.ai_data_sharing_enabled=true AND p.profile_visibility='public' AND p.posts_visibility='public')
 THEN DELETE FROM public.ad_audience_cache WHERE user_id=u; RETURN '{}'; END IF;
 SELECT topics INTO result FROM public.ad_audience_cache WHERE user_id=u AND updated_at>now()-interval '5 minutes';
 IF FOUND THEN RETURN result; END IF;
 cutoff:=greatest(pref.activity_since,now()-interval '30 days');
 WITH own_posts AS (
   SELECT p.body,p.user_id author_id FROM public.posts p WHERE p.user_id=u AND p.created_at>=cutoff
   AND (p.expires_at IS NULL OR p.expires_at>now()) AND (p.publish_at IS NULL OR p.publish_at<=now())
   ORDER BY p.created_at DESC LIMIT 30
 ), own_comments AS (
   SELECT c.body,p.user_id author_id FROM public.comments c JOIN public.posts p ON p.id=c.post_id
   JOIN public.privacy_settings ps ON ps.user_id=p.user_id
   WHERE c.user_id=u AND c.created_at>=cutoff AND NOT c.is_zeus_reply
   AND ps.profile_visibility='public' AND ps.posts_visibility='public'
   AND (p.expires_at IS NULL OR p.expires_at>now()) AND (p.publish_at IS NULL OR p.publish_at<=now())
   AND NOT EXISTS(SELECT 1 FROM public.user_message_blocks b WHERE
     (b.blocker_user_id=u AND b.blocked_user_id=p.user_id) OR (b.blocker_user_id=p.user_id AND b.blocked_user_id=u))
   ORDER BY c.created_at DESC LIMIT 50
 ), watched AS (
   SELECT DISTINCT p.id,p.body,p.user_id author_id FROM (
     SELECT i.post_id FROM public.ml_interactions i WHERE i.user_id=u AND i.created_at>=cutoff
     AND i.surface='feed' AND i.exposure_id IS NOT NULL AND i.signal_type='watch_complete'
     ORDER BY i.created_at DESC LIMIT 100
   ) i JOIN public.posts p ON p.id=i.post_id JOIN public.privacy_settings ps ON ps.user_id=p.user_id
   WHERE ps.profile_visibility='public' AND ps.posts_visibility='public' AND ps.ai_data_sharing_enabled=true
   AND p.image_url ~* '\.(mp4|webm|mov|m4v)(\?|#|$)'
   AND (p.expires_at IS NULL OR p.expires_at>now()) AND (p.publish_at IS NULL OR p.publish_at<=now())
   AND NOT EXISTS(SELECT 1 FROM public.user_message_blocks b WHERE
     (b.blocker_user_id=u AND b.blocked_user_id=p.user_id) OR (b.blocker_user_id=p.user_id AND b.blocked_user_id=u))
 ), sources AS (
   SELECT body,author_id FROM own_posts UNION ALL SELECT body,author_id FROM own_comments UNION ALL SELECT body,author_id FROM watched
 ), signals AS (
   SELECT unnest(public.ad_text_topics_internal(body)) topic FROM sources
 ) SELECT (SELECT coalesce(array_agg(topic ORDER BY hits DESC,topic),'{}')
 FROM (SELECT topic,count(*) hits FROM signals GROUP BY topic HAVING count(*)>=2) counted),
 (SELECT coalesce(array_agg(DISTINCT author_id),'{}') FROM sources) INTO result,authors;
 INSERT INTO public.ad_audience_cache(user_id,topics,updated_at) VALUES(u,result,now())
 ON CONFLICT(user_id) DO UPDATE SET topics=excluded.topics,updated_at=excluded.updated_at;
 DELETE FROM public.ad_audience_sources WHERE user_id=u;
 INSERT INTO public.ad_audience_sources(user_id,author_id) SELECT u,unnest(authors) ON CONFLICT DO NOTHING;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.refresh_my_ad_audience() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.refresh_my_ad_audience() TO authenticated;

CREATE FUNCTION public.invalidate_ad_audience() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM public.ad_audience_cache WHERE user_id=OLD.user_id
 OR user_id IN (SELECT s.user_id FROM public.ad_audience_sources s WHERE s.author_id=OLD.user_id);
 RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.invalidate_ad_audience() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER ad_privacy_withdrawal AFTER UPDATE OR DELETE ON public.privacy_settings FOR EACH ROW EXECUTE FUNCTION public.invalidate_ad_audience();
CREATE TRIGGER ad_profile_changed AFTER UPDATE OR DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.invalidate_ad_audience();
CREATE TRIGGER ad_post_changed AFTER UPDATE OF body,expires_at,publish_at OR DELETE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.invalidate_ad_audience();
CREATE TRIGGER ad_comment_changed AFTER UPDATE OR DELETE ON public.comments FOR EACH ROW EXECUTE FUNCTION public.invalidate_ad_audience();

CREATE FUNCTION public.ad_my_topics_internal(p_user uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(array_agg(DISTINCT topic) FILTER(WHERE topic IS NOT NULL),'{}') FROM (
 SELECT public.ad_topic_internal(x) topic FROM public.discovery_preferences d
 JOIN public.profiles p ON p.user_id=d.user_id CROSS JOIN LATERAL unnest(p.interests) x
 WHERE d.user_id=p_user AND d.ads_profile=true AND public.ad_adult_internal(p_user)
 UNION ALL
 SELECT unnest(c.topics) FROM public.ad_audience_cache c
 JOIN public.discovery_preferences d ON d.user_id=c.user_id
 JOIN public.privacy_settings p ON p.user_id=d.user_id
 WHERE d.user_id=p_user AND d.ads_activity AND public.ad_adult_internal(p_user)
 AND c.updated_at>now()-interval '5 minutes' AND p.analytics_enabled AND p.ai_data_sharing_enabled
 AND p.profile_visibility='public' AND p.posts_visibility='public'
 AND NOT EXISTS(SELECT 1 FROM public.ad_audience_sources s
 LEFT JOIN public.privacy_settings ps ON ps.user_id=s.author_id
 WHERE s.user_id=p_user AND (ps.user_id IS NULL OR ps.profile_visibility<>'public' OR ps.posts_visibility<>'public'
 OR NOT ps.ai_data_sharing_enabled OR EXISTS(SELECT 1 FROM public.user_message_blocks b WHERE
 (b.blocker_user_id=p_user AND b.blocked_user_id=s.author_id) OR (b.blocker_user_id=s.author_id AND b.blocked_user_id=p_user))))
 ) t;
$$;
REVOKE ALL ON FUNCTION public.ad_my_topics_internal(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.ad_location_matches_internal(p_target jsonb,p_country text,p_region text,p_city text,p_consent boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE cities jsonb; country text; region text;
BEGIN
 IF p_target IS NULL OR p_target='{}'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(p_target)<>'object' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_target) k WHERE k NOT IN ('country','region','villes'))
 OR EXISTS(SELECT 1 FROM jsonb_each(p_target) x WHERE x.key IN ('country','region') AND jsonb_typeof(x.value) NOT IN ('string','null'))
 THEN RETURN false; END IF;
 country:=nullif(upper(p_target->>'country'),''); region:=nullif(trim(p_target->>'region'),'');
 cities:=coalesce(p_target->'villes','[]'::jsonb);
 IF jsonb_typeof(cities)<>'array' OR jsonb_array_length(cities)>100 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(cities) c WHERE jsonb_typeof(c)<>'string') THEN RETURN false; END IF;
 IF (country IS NULL OR country='FR') AND region IS NULL AND jsonb_array_length(cities)=0 THEN RETURN true; END IF;
 IF NOT coalesce(p_consent,false) OR p_country IS NULL THEN RETURN false; END IF;
 RETURN (country IS NULL OR country=p_country)
 AND (region IS NULL OR lower(region)=lower(coalesce(p_region,'')))
 AND (jsonb_array_length(cities)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(cities) v WHERE lower(v)=lower(coalesce(p_city,''))));
END; $$;
REVOKE ALL ON FUNCTION public.ad_location_matches_internal(jsonb,text,text,text,boolean) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.ad_is_deliverable_internal(p_ad uuid,p_user uuid,p_placement text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.ads a JOIN public.ad_sets s ON s.id=a.ad_set_id
 JOIN public.ad_campaigns c ON c.id=s.campaign_id JOIN public.profiles p ON p.user_id=p_user
 LEFT JOIN public.discovery_preferences d ON d.user_id=p_user
 WHERE a.id=p_ad AND p_user IS NOT NULL AND public.ad_adult_internal(p_user)
 AND p_placement='feed' AND p_placement=ANY(s.placements) AND a.advertiser_id<>p_user
 AND c.status='active' AND c.paid_at IS NOT NULL AND c.starts_at<=now() AND c.ends_at>now()
 AND s.status='active' AND s.starts_at<=now() AND s.ends_at>now() AND a.status='active' AND a.moderation_status='approved'
 AND coalesce(s.target_gender,'all')='all'
 AND (coalesce(cardinality(s.target_interests),0)=0 OR (
   NOT EXISTS(SELECT 1 FROM unnest(s.target_interests) x WHERE public.ad_topic_internal(x) IS NULL)
   AND public.ad_my_topics_internal(p_user) && ARRAY(SELECT public.ad_topic_internal(x) FROM unnest(s.target_interests) x)))
 AND ((coalesce(s.target_age_min,18)<=18 AND coalesce(s.target_age_max,120)>=65)
   OR (coalesce(d.ads_profile,false) AND extract(year FROM age(current_date,p.date_of_birth)) BETWEEN s.target_age_min AND CASE WHEN s.target_age_max>=65 THEN 200 ELSE s.target_age_max END))
 AND public.ad_location_matches_internal(s.target_location,d.country,d.region,d.city,d.ads_location AND d.local_media)
 AND NOT EXISTS(SELECT 1 FROM public.user_message_blocks b WHERE
   (b.blocker_user_id=p_user AND b.blocked_user_id=a.advertiser_id) OR (b.blocker_user_id=a.advertiser_id AND b.blocked_user_id=p_user)));
$$;
REVOKE ALL ON FUNCTION public.ad_is_deliverable_internal(uuid,uuid,text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_active_ads_for_placement(p_placement text DEFAULT 'feed',p_limit integer DEFAULT 12)
RETURNS TABLE(id uuid,headline text,primary_text text,image_url text,video_url text,cta_text text,cta_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT a.id,a.headline,a.primary_text,a.image_url,a.video_url,coalesce(a.cta_text,'En savoir plus'),a.cta_url
 FROM public.ads a JOIN public.ad_sets s ON s.id=a.ad_set_id JOIN public.ad_campaigns c ON c.id=s.campaign_id
 WHERE a.status='active' AND a.moderation_status='approved' AND s.status='active' AND c.status='active'
 AND c.paid_at IS NOT NULL AND c.ends_at>now() AND s.ends_at>now()
 AND public.ad_is_deliverable_internal(a.id,(SELECT auth.uid()),p_placement)
 ORDER BY (SELECT count(*) FROM unnest(s.target_interests) t WHERE public.ad_topic_internal(t)=ANY(public.ad_my_topics_internal((SELECT auth.uid())))) DESC,
 a.impressions,md5(a.id::text||coalesce((SELECT auth.uid())::text,'')||current_date::text)
 LIMIT least(30,greatest(1,coalesce(p_limit,12)));
$$;
REVOKE ALL ON FUNCTION public.get_active_ads_for_placement(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_active_ads_for_placement(text,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.track_ad_interaction(p_ad_id uuid,p_kind text,p_placement text DEFAULT 'feed')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=auth.uid(); campaign uuid; inserted integer; imp integer; clk integer; reach_delta integer:=0;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('impression','click') THEN RAISE EXCEPTION 'INVALID_AD_INTERACTION'; END IF;
 IF NOT public.ad_is_deliverable_internal(p_ad_id,u,p_placement) THEN RAISE EXCEPTION 'AD_NOT_DELIVERABLE' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(u::text||p_ad_id::text,0));
 SELECT s.campaign_id INTO campaign FROM public.ads a JOIN public.ad_sets s ON s.id=a.ad_set_id WHERE a.id=p_ad_id;
 IF p_kind='impression' AND NOT EXISTS(SELECT 1 FROM public.ad_interactions WHERE user_id=u AND ad_id=p_ad_id AND interaction_type='impression') THEN reach_delta:=1; END IF;
 INSERT INTO public.ad_interactions(campaign_id,ad_id,user_id,interaction_type,placement,interaction_day)
 VALUES(campaign,p_ad_id,u,p_kind,p_placement,current_date) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted=0 THEN RETURN false; END IF;
 imp:=(p_kind='impression')::integer; clk:=(p_kind='click')::integer;
 UPDATE public.ads SET impressions=impressions+imp,clicks=clicks+clk,reach=reach+reach_delta,updated_at=now() WHERE id=p_ad_id;
 UPDATE public.ad_campaigns SET impressions=impressions+imp,clicks=clicks+clk,reach=reach+reach_delta,updated_at=now() WHERE id=campaign;
 INSERT INTO public.ad_daily_stats(campaign_id,stat_date,impressions,clicks,reach,spent)
 VALUES(campaign,current_date,imp,clk,imp,0) ON CONFLICT(campaign_id,stat_date) DO UPDATE
 SET impressions=public.ad_daily_stats.impressions+excluded.impressions,clicks=public.ad_daily_stats.clicks+excluded.clicks,reach=public.ad_daily_stats.reach+excluded.reach;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.track_ad_interaction(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.track_ad_interaction(uuid,text,text) TO authenticated;

CREATE FUNCTION public.get_my_ad_explanation(p_ad_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('topics',ARRAY(SELECT public.ad_topic_internal(t) FROM unnest(s.target_interests) t
   WHERE public.ad_topic_internal(t)=ANY(public.ad_my_topics_internal(auth.uid()))),
   'local',NOT public.ad_location_matches_internal(s.target_location,NULL,NULL,NULL,false),
   'advertiser',p.name,'ageRange',CASE WHEN s.target_age_min>18 OR s.target_age_max<65 THEN jsonb_build_array(s.target_age_min,s.target_age_max) END)
 FROM public.ads a JOIN public.ad_sets s ON s.id=a.ad_set_id JOIN public.profiles p ON p.user_id=a.advertiser_id
 WHERE a.id=p_ad_id AND public.ad_is_deliverable_internal(a.id,auth.uid(),'feed');
$$;
REVOKE ALL ON FUNCTION public.get_my_ad_explanation(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_ad_explanation(uuid) TO authenticated;

CREATE TABLE public.media_partners (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 website_host text NOT NULL CHECK(website_host ~ '^[a-z0-9]+([.-][a-z0-9]+)*\.[a-z]{2,}$'),
 country text NOT NULL DEFAULT 'FR' CHECK(country ~ '^[A-Z]{2}$'), region text, city text,
 agreement_reference text NOT NULL CHECK(length(agreement_reference) BETWEEN 1 AND 500),
 rights_until timestamptz NOT NULL, allow_excerpt boolean NOT NULL DEFAULT false,
 allow_youtube_embed boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT false
);
CREATE TABLE public.partner_media_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid NOT NULL REFERENCES public.media_partners(id) ON DELETE CASCADE,
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 200),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 220), excerpt text NOT NULL DEFAULT '' CHECK(length(excerpt)<=400),
 canonical_url text NOT NULL CHECK(length(canonical_url)<=2048),
 kind text NOT NULL CHECK(kind IN ('article','video')), youtube_id text CHECK(youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
 published_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 moderated boolean NOT NULL DEFAULT false, family_safe boolean NOT NULL DEFAULT false,
 UNIQUE(partner_id,external_id), CHECK(expires_at>published_at)
);
CREATE INDEX partner_media_recent ON public.partner_media_items(published_at DESC) WHERE moderated=true;
ALTER TABLE public.media_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_media_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_partners,public.partner_media_items FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.media_partners,public.partner_media_items TO service_role;

CREATE FUNCTION public.enforce_partner_media_rights() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE partner public.media_partners;
BEGIN
 SELECT * INTO partner FROM public.media_partners WHERE id=NEW.partner_id;
 IF NOT coalesce(partner.active,false) OR partner.rights_until<=now() THEN RAISE EXCEPTION 'PARTNER_RIGHTS_REQUIRED'; END IF;
 IF NEW.canonical_url NOT LIKE 'https://'||partner.website_host||'/%' OR NEW.canonical_url ~ '[[:cntrl:]\\]' THEN RAISE EXCEPTION 'INVALID_PARTNER_URL'; END IF;
 IF NEW.excerpt<>'' AND NOT partner.allow_excerpt THEN RAISE EXCEPTION 'EXCERPT_RIGHTS_REQUIRED'; END IF;
 IF NEW.youtube_id IS NOT NULL AND (NOT partner.allow_youtube_embed OR NEW.kind<>'video') THEN RAISE EXCEPTION 'EMBED_RIGHTS_REQUIRED'; END IF;
 NEW.expires_at:=least(NEW.expires_at,partner.rights_until,NEW.published_at+interval '30 days');
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.enforce_partner_media_rights() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER partner_rights BEFORE INSERT OR UPDATE ON public.partner_media_items FOR EACH ROW EXECUTE FUNCTION public.enforce_partner_media_rights();

CREATE FUNCTION public.import_partner_media(p_partner uuid,p_items jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; changed integer; total integer:=0;
BEGIN
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>50
 OR pg_column_size(p_items)>262144 THEN RAISE EXCEPTION 'INVALID_MEDIA_BATCH'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
   IF jsonb_typeof(item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k
     WHERE k NOT IN ('external_id','title','excerpt','canonical_url','kind','youtube_id','published_at','expires_at'))
     OR EXISTS(SELECT 1 FROM jsonb_each(item) x WHERE jsonb_typeof(x.value) NOT IN ('string','null'))
   THEN RAISE EXCEPTION 'INVALID_MEDIA_ITEM'; END IF;
   INSERT INTO public.partner_media_items(partner_id,external_id,title,excerpt,canonical_url,kind,youtube_id,published_at,expires_at)
   VALUES(p_partner,item->>'external_id',item->>'title',coalesce(item->>'excerpt',''),item->>'canonical_url',item->>'kind',item->>'youtube_id',
     (item->>'published_at')::timestamptz,(item->>'expires_at')::timestamptz)
   ON CONFLICT(partner_id,external_id) DO UPDATE SET
     title=excluded.title,excerpt=excluded.excerpt,canonical_url=excluded.canonical_url,kind=excluded.kind,youtube_id=excluded.youtube_id,
     published_at=excluded.published_at,expires_at=excluded.expires_at,moderated=false,family_safe=false
   WHERE (public.partner_media_items.title,public.partner_media_items.excerpt,public.partner_media_items.canonical_url,public.partner_media_items.kind,
     public.partner_media_items.youtube_id,public.partner_media_items.published_at,public.partner_media_items.expires_at)
     IS DISTINCT FROM (excluded.title,excluded.excerpt,excluded.canonical_url,excluded.kind,excluded.youtube_id,excluded.published_at,excluded.expires_at);
   GET DIAGNOSTICS changed=ROW_COUNT; total:=total+changed;
 END LOOP;
 RETURN total;
END; $$;
REVOKE ALL ON FUNCTION public.import_partner_media(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_partner_media(uuid,jsonb) TO service_role;

CREATE FUNCTION public.get_local_partner_media(p_scope text DEFAULT 'france',p_kind text DEFAULT 'all') RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(row_to_json(item)),'[]'::jsonb) FROM (
 SELECT m.id,m.title,CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END excerpt,m.canonical_url,m.kind,
 CASE WHEN p.allow_youtube_embed THEN m.youtube_id END youtube_id,m.published_at,p.name source_name,
 p.country,p.region,p.city
 FROM public.partner_media_items m JOIN public.media_partners p ON p.id=m.partner_id
 LEFT JOIN public.discovery_preferences d ON d.user_id=(SELECT auth.uid())
 WHERE (SELECT auth.uid()) IS NOT NULL AND p_scope IN ('city','region','france') AND p_kind IN ('all','article','video')
 AND p.active AND p.rights_until>now() AND m.expires_at>now() AND m.published_at<=now() AND m.moderated
 AND (public.ad_adult_internal((SELECT auth.uid())) OR m.family_safe)
 AND (p_kind='all' OR m.kind=p_kind)
 AND ((p_scope='france' AND p.country='FR') OR (d.local_media AND p.country=d.country AND
   ((p_scope='city' AND lower(p.city)=lower(d.city) AND lower(p.region)=lower(d.region))
     OR (p_scope='region' AND lower(p.region)=lower(d.region)))))
 ORDER BY m.published_at DESC,m.id LIMIT 12
 ) item;
$$;
REVOKE ALL ON FUNCTION public.get_local_partner_media(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_local_partner_media(text,text) TO authenticated;

CREATE FUNCTION public.cleanup_discovery_data() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 DELETE FROM public.ad_audience_cache WHERE updated_at<=now()-interval '5 minutes';
 DELETE FROM public.partner_media_items WHERE expires_at<=now();
$$;
REVOKE ALL ON FUNCTION public.cleanup_discovery_data() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_discovery_data() TO service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
   PERFORM cron.schedule('discovery-expiry-cleanup','*/15 * * * *','SELECT public.cleanup_discovery_data()');
 ELSE
   RAISE WARNING 'Schedule cleanup_discovery_data every 15 minutes in Lovable Cloud before enabling discovery.';
 END IF;
END $$;