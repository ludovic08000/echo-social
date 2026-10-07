ALTER TABLE public.discovery_preferences ADD COLUMN ads_location_auto boolean NOT NULL DEFAULT false;
ALTER TABLE public.discovery_preferences ADD CONSTRAINT ads_auto_requires_consent CHECK (NOT ads_location_auto OR ads_location);
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.discovery_preferences'::regclass
   AND contype='c' AND pg_get_constraintdef(oid) LIKE '%local_media%'
 LOOP EXECUTE format('ALTER TABLE public.discovery_preferences DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE public.discovery_preferences ADD CONSTRAINT discovery_location_purpose
 CHECK (local_media OR ads_location OR (country IS NULL AND region IS NULL AND city IS NULL));

CREATE TABLE public.ad_location_contexts (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,
 country text CHECK (country ~ '^[A-Z]{2}$'), region text CHECK (length(region) BETWEEN 1 AND 100),
 city text CHECK (length(city) BETWEEN 1 AND 100),
 source text NOT NULL CHECK (source IN ('profile','network','unavailable')),
 preference_revision timestamptz NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 PRIMARY KEY(user_id,session_id),
 CHECK ((source='unavailable' AND country IS NULL AND region IS NULL AND city IS NULL)
   OR (source<>'unavailable' AND country IS NOT NULL)),
 CHECK (city IS NULL OR region IS NOT NULL)
);
CREATE INDEX ad_location_context_expiry ON public.ad_location_contexts(expires_at);
ALTER TABLE public.ad_location_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_location_contexts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.ad_location_contexts TO service_role;

CREATE OR REPLACE FUNCTION public.set_discovery_preferences(p_preferences jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=auth.uid(); previous public.discovery_preferences; saved public.discovery_preferences;
 a boolean; b boolean; c boolean; l boolean; automatic boolean;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_preferences) IS DISTINCT FROM 'object' OR pg_column_size(p_preferences)>2048
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_preferences) k WHERE k NOT IN ('ads_profile','ads_activity','ads_location','ads_location_auto','local_media','country','region','city'))
 OR EXISTS(SELECT 1 FROM jsonb_each(p_preferences) x WHERE x.key IN ('ads_profile','ads_activity','ads_location','ads_location_auto','local_media') AND jsonb_typeof(x.value)<>'boolean')
 OR EXISTS(SELECT 1 FROM jsonb_each(p_preferences) x WHERE x.key IN ('country','region','city') AND jsonb_typeof(x.value) NOT IN ('string','null'))
 THEN RAISE EXCEPTION 'INVALID_PREFERENCES' USING ERRCODE='22023'; END IF;
 a:=coalesce((p_preferences->>'ads_profile')::boolean,false);
 b:=coalesce((p_preferences->>'ads_activity')::boolean,false);
 c:=coalesce((p_preferences->>'ads_location')::boolean,false);
 l:=coalesce((p_preferences->>'local_media')::boolean,false);
 automatic:=coalesce((p_preferences->>'ads_location_auto')::boolean,false);
 IF automatic AND NOT c THEN RAISE EXCEPTION 'INVALID_PREFERENCES' USING ERRCODE='22023'; END IF;
 IF (a OR b OR c OR automatic) AND NOT public.ad_adult_internal(u) THEN RAISE EXCEPTION 'ADULT_ONLY' USING ERRCODE='42501'; END IF;
 INSERT INTO public.discovery_preferences(user_id) VALUES(u) ON CONFLICT DO NOTHING;
 SELECT * INTO previous FROM public.discovery_preferences WHERE user_id=u FOR UPDATE;
 UPDATE public.discovery_preferences SET ads_profile=a,ads_activity=b,ads_location=c,ads_location_auto=automatic,local_media=l,
 country=CASE WHEN l OR c THEN nullif(upper(trim(p_preferences->>'country')),'') END,
 region=CASE WHEN l OR c THEN nullif(trim(p_preferences->>'region'),'') END,
 city=CASE WHEN l OR c THEN nullif(trim(p_preferences->>'city'),'') END,
 activity_since=CASE WHEN b THEN CASE WHEN previous.ads_activity THEN previous.activity_since ELSE now() END END,
 consent_revision='ads-local-2026-10-auto',updated_at=clock_timestamp() WHERE user_id=u RETURNING * INTO saved;
 DELETE FROM public.ad_audience_cache WHERE user_id=u;
 DELETE FROM public.ad_location_contexts WHERE user_id=u;
 RETURN to_jsonb(saved);
END; $$;
REVOKE ALL ON FUNCTION public.set_discovery_preferences(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_discovery_preferences(jsonb) TO authenticated;

CREATE FUNCTION public.ad_session_internal() RETURNS uuid LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE WHEN auth.jwt()->>'session_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
 THEN (auth.jwt()->>'session_id')::uuid END;
$$;
REVOKE ALL ON FUNCTION public.ad_session_internal() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.ad_effective_location_internal(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.discovery_preferences; result jsonb;
BEGIN
 IF NOT public.ad_adult_internal(p_user) THEN RETURN NULL; END IF;
 SELECT * INTO d FROM public.discovery_preferences WHERE user_id=p_user;
 IF NOT coalesce(d.ads_location,false) THEN RETURN NULL; END IF;
 IF d.country IS NOT NULL OR d.region IS NOT NULL OR d.city IS NOT NULL THEN
   RETURN jsonb_build_object('country',d.country,'region',d.region,'city',d.city,'source','selected');
 END IF;
 IF NOT d.ads_location_auto THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('country',c.country,'region',c.region,'city',c.city,'source',c.source) INTO result
 FROM public.ad_location_contexts c WHERE c.user_id=p_user AND c.session_id=public.ad_session_internal()
 AND c.preference_revision=d.updated_at AND c.expires_at>now() AND c.source<>'unavailable';
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.ad_effective_location_internal(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.get_my_ad_location_context() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=auth.uid(); s uuid:=public.ad_session_internal(); d public.discovery_preferences; cached jsonb; profile_city text;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM public.discovery_preferences WHERE user_id=u;
 IF NOT coalesce(d.ads_location AND d.ads_location_auto,false) OR NOT public.ad_adult_internal(u) OR s IS NULL
   OR d.country IS NOT NULL OR d.region IS NOT NULL OR d.city IS NOT NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('country',c.country,'region',c.region,'city',c.city,'source',c.source,'expiresAt',c.expires_at) INTO cached
 FROM public.ad_location_contexts c WHERE c.user_id=u AND c.session_id=s AND c.preference_revision=d.updated_at AND c.expires_at>now();
 IF cached IS NULL THEN SELECT left(p.city,100) INTO profile_city FROM public.profiles p WHERE p.user_id=u; END IF;
 RETURN jsonb_build_object('sessionId',s,'revision',d.updated_at,'cached',cached,'profileCity',profile_city);
END; $$;
REVOKE ALL ON FUNCTION public.get_my_ad_location_context() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_ad_location_context() TO authenticated;

CREATE FUNCTION public.store_ad_location_context(p_user uuid,p_session uuid,p_revision timestamptz,p_country text,p_region text,p_city text,p_source text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.discovery_preferences;
BEGIN
 SELECT * INTO d FROM public.discovery_preferences WHERE user_id=p_user FOR UPDATE;
 IF NOT coalesce(d.ads_location AND d.ads_location_auto,false) OR d.updated_at IS DISTINCT FROM p_revision
   OR NOT public.ad_adult_internal(p_user) OR p_session IS NULL
   OR d.country IS NOT NULL OR d.region IS NOT NULL OR d.city IS NOT NULL THEN RETURN false; END IF;
 DELETE FROM public.ad_location_contexts WHERE user_id=p_user AND expires_at<=now();
 INSERT INTO public.ad_location_contexts(user_id,session_id,country,region,city,source,preference_revision)
 VALUES(p_user,p_session,p_country,p_region,p_city,p_source,p_revision)
 ON CONFLICT(user_id,session_id) DO UPDATE SET country=excluded.country,region=excluded.region,city=excluded.city,
 source=excluded.source,preference_revision=excluded.preference_revision,expires_at=excluded.expires_at;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.store_ad_location_context(uuid,uuid,timestamptz,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.store_ad_location_context(uuid,uuid,timestamptz,text,text,text,text) TO service_role;

CREATE FUNCTION public.invalidate_ad_location_context() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.city IS DISTINCT FROM OLD.city OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth THEN
   UPDATE public.discovery_preferences SET updated_at=clock_timestamp() WHERE user_id=NEW.user_id AND ads_location_auto;
   DELETE FROM public.ad_location_contexts WHERE user_id=NEW.user_id;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.invalidate_ad_location_context() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER invalidate_ad_location_profile AFTER UPDATE OF city,date_of_birth ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.invalidate_ad_location_context();

CREATE FUNCTION public.ad_place_key_internal(p_label text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT regexp_replace(translate(lower(trim(coalesce(p_label,''))),'àâäéèêëîïôöùûüçÿ','aaaeeeeiioouuucy'),'[^a-z0-9]','','g');
$$;
REVOKE ALL ON FUNCTION public.ad_place_key_internal(text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.ad_location_matches_internal(p_target jsonb,p_country text,p_region text,p_city text,p_consent boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE cities jsonb; country text; region text;
BEGIN
 IF p_target IS NULL OR p_target='{}'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(p_target)<>'object' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_target) k WHERE k NOT IN ('country','region','villes'))
 OR EXISTS(SELECT 1 FROM jsonb_each(p_target) x WHERE x.key IN ('country','region') AND jsonb_typeof(x.value) NOT IN ('string','null')) THEN RETURN false; END IF;
 country:=nullif(upper(trim(p_target->>'country')),''); region:=nullif(trim(p_target->>'region'),'');
 IF region IS NOT NULL AND public.ad_place_key_internal(region)='' THEN RETURN false; END IF;
 cities:=coalesce(p_target->'villes','[]'::jsonb);
 IF jsonb_typeof(cities)<>'array' OR jsonb_array_length(cities)>100 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(cities) c WHERE jsonb_typeof(c)<>'string' OR public.ad_place_key_internal(c#>>'{}')='') THEN RETURN false; END IF;
 IF (country IS NULL OR country='FR') AND region IS NULL AND jsonb_array_length(cities)=0 THEN RETURN true; END IF;
 IF NOT coalesce(p_consent,false) OR p_country IS NULL THEN RETURN false; END IF;
 RETURN (country IS NULL OR country=p_country)
 AND (region IS NULL OR public.ad_place_key_internal(region)=public.ad_place_key_internal(p_region))
 AND (jsonb_array_length(cities)=0 OR (region IS NOT NULL AND p_city IS NOT NULL AND EXISTS(
   SELECT 1 FROM jsonb_array_elements_text(cities) v WHERE public.ad_place_key_internal(v)=public.ad_place_key_internal(p_city))));
END; $$;

CREATE OR REPLACE FUNCTION public.cleanup_discovery_data() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 DELETE FROM public.ad_audience_cache WHERE updated_at<=now()-interval '5 minutes';
 DELETE FROM public.partner_media_items WHERE expires_at<=now();
 DELETE FROM public.ad_location_contexts WHERE expires_at<=now();
$$;
CREATE OR REPLACE FUNCTION public.ad_is_deliverable_internal(p_ad uuid,p_user uuid,p_placement text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.ads a JOIN public.ad_sets s ON s.id=a.ad_set_id
 JOIN public.ad_campaigns c ON c.id=s.campaign_id JOIN public.profiles p ON p.user_id=p_user
 LEFT JOIN public.discovery_preferences d ON d.user_id=p_user
 CROSS JOIN LATERAL (SELECT public.ad_effective_location_internal(p_user) value) loc
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
 AND public.ad_location_matches_internal(s.target_location,loc.value->>'country',loc.value->>'region',loc.value->>'city',d.ads_location)
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
 ORDER BY (NOT public.ad_location_matches_internal(s.target_location,NULL,NULL,NULL,false)) DESC,
 (SELECT count(*) FROM unnest(s.target_interests) t WHERE public.ad_topic_internal(t)=ANY(public.ad_my_topics_internal((SELECT auth.uid())))) DESC,
 a.impressions,md5(a.id::text||coalesce((SELECT auth.uid())::text,'')||current_date::text)
 LIMIT least(30,greatest(1,coalesce(p_limit,12)));
$$;
REVOKE ALL ON FUNCTION public.get_active_ads_for_placement(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_active_ads_for_placement(text,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_ad_explanation(p_ad_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('topics',ARRAY(SELECT public.ad_topic_internal(t) FROM unnest(s.target_interests) t
   WHERE public.ad_topic_internal(t)=ANY(public.ad_my_topics_internal(auth.uid()))),
   'local',NOT public.ad_location_matches_internal(s.target_location,NULL,NULL,NULL,false),
   'zone',CASE WHEN NOT public.ad_location_matches_internal(s.target_location,NULL,NULL,NULL,false)
     THEN public.ad_effective_location_internal(auth.uid()) END,
   'advertiser',p.name,'ageRange',CASE WHEN s.target_age_min>18 OR s.target_age_max<65 THEN jsonb_build_array(s.target_age_min,s.target_age_max) END)
 FROM public.ads a JOIN public.ad_sets s ON s.id=a.ad_set_id JOIN public.profiles p ON p.user_id=a.advertiser_id
 WHERE a.id=p_ad_id AND public.ad_is_deliverable_internal(a.id,auth.uid(),'feed');
$$;
REVOKE ALL ON FUNCTION public.get_my_ad_explanation(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_ad_explanation(uuid) TO authenticated;