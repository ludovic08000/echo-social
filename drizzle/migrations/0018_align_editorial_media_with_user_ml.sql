ALTER TABLE public.user_feed_preferences
  ADD COLUMN IF NOT EXISTS weight_news integer NOT NULL DEFAULT 30;

ALTER TABLE public.user_feed_preferences
  DROP CONSTRAINT IF EXISTS user_feed_preferences_weight_news_check;
ALTER TABLE public.user_feed_preferences
  ADD CONSTRAINT user_feed_preferences_weight_news_check
  CHECK (weight_news BETWEEN 0 AND 100);

COMMENT ON COLUMN public.user_feed_preferences.weight_news IS
  'Explicit user-selected weight for local and positive editorial media in the social feed (0..100).';

CREATE OR REPLACE FUNCTION public.feed_normalize_topic(p_topic text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT CASE pg_catalog.lower(pg_catalog.btrim(COALESCE(p_topic, '')))
    WHEN 'content.topictech' THEN 'technology'
    WHEN 'tech' THEN 'technology'
    WHEN 'technologie' THEN 'technology'
    WHEN 'content.topicsport' THEN 'sport'
    WHEN 'sports' THEN 'sport'
    WHEN 'content.topicart' THEN 'art'
    WHEN 'content.topicmusic' THEN 'music'
    WHEN 'musique' THEN 'music'
    WHEN 'content.topiccooking' THEN 'cooking'
    WHEN 'cuisine' THEN 'cooking'
    WHEN 'content.topictravel' THEN 'travel'
    WHEN 'voyage' THEN 'travel'
    WHEN 'content.topicscience' THEN 'science'
    WHEN 'content.topiceducation' THEN 'education'
    WHEN 'éducation' THEN 'education'
    WHEN 'content.topicwellbeing' THEN 'wellbeing'
    WHEN 'well-being' THEN 'wellbeing'
    WHEN 'bien-être' THEN 'wellbeing'
    WHEN 'bien etre' THEN 'wellbeing'
    WHEN 'lifestyle' THEN 'wellbeing'
    WHEN 'psychology' THEN 'wellbeing'
    WHEN 'psychologie' THEN 'wellbeing'
    WHEN 'content.topicfashion' THEN 'fashion'
    WHEN 'content.topiccinema' THEN 'cinema'
    WHEN 'cinéma' THEN 'cinema'
    WHEN 'content.topicliterature' THEN 'literature'
    WHEN 'littérature' THEN 'literature'
    WHEN 'content.topicgaming' THEN 'gaming'
    WHEN 'content.topicnature' THEN 'nature'
    WHEN 'content.topicnews' THEN 'news'
    WHEN 'actualité' THEN 'news'
    WHEN 'actualités' THEN 'news'
    ELSE pg_catalog.lower(pg_catalog.btrim(COALESCE(p_topic, '')))
  END;
$function$;

REVOKE ALL ON FUNCTION public.feed_normalize_topic(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_normalize_topic(text) TO service_role;

CREATE OR REPLACE FUNCTION public.validate_user_feed_preferences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.feed_algorithm NOT IN ('smart','chronological','friends_first') THEN
    NEW.feed_algorithm := 'smart';
  END IF;

  NEW.diversity_boost := GREATEST(0, LEAST(100, NEW.diversity_boost));
  NEW.weight_friends := GREATEST(0, LEAST(100, NEW.weight_friends));
  NEW.weight_discovery := GREATEST(0, LEAST(100, NEW.weight_discovery));
  NEW.weight_news := GREATEST(0, LEAST(100, NEW.weight_news));
  NEW.weight_marketplace := GREATEST(0, LEAST(100, NEW.weight_marketplace));

  IF NEW.muted_keywords IS NULL THEN
    NEW.muted_keywords := ARRAY[]::text[];
  END IF;
  IF pg_catalog.array_length(NEW.muted_keywords, 1) > 100 THEN
    NEW.muted_keywords := NEW.muted_keywords[1:100];
  END IF;
  NEW.muted_keywords := ARRAY(
    SELECT pg_catalog.lower(pg_catalog.substr(pg_catalog.btrim(keyword.value),1,60))
    FROM pg_catalog.unnest(NEW.muted_keywords) AS keyword(value)
    WHERE pg_catalog.length(pg_catalog.btrim(keyword.value)) > 0
  );

  NEW.priority_topics := ARRAY(
    SELECT normalized.topic
    FROM (
      SELECT
        public.feed_normalize_topic(raw_topic.value) AS topic,
        pg_catalog.min(raw_topic.position) AS first_position
      FROM pg_catalog.unnest(COALESCE(NEW.priority_topics, ARRAY[]::text[]))
        WITH ORDINALITY AS raw_topic(value, position)
      WHERE pg_catalog.length(pg_catalog.btrim(raw_topic.value)) > 0
      GROUP BY public.feed_normalize_topic(raw_topic.value)
    ) AS normalized
    WHERE normalized.topic = ANY(ARRAY[
      'news','technology','sport','art','music','cooking','travel','science',
      'education','wellbeing','fashion','cinema','literature','gaming','nature','comedy'
    ]::text[])
    ORDER BY normalized.first_position
    LIMIT 50
  );

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_user_feed_preferences()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_validate_user_feed_preferences
  ON public.user_feed_preferences;
CREATE TRIGGER trg_validate_user_feed_preferences
  BEFORE INSERT OR UPDATE ON public.user_feed_preferences
  FOR EACH ROW EXECUTE FUNCTION public.validate_user_feed_preferences();

CREATE OR REPLACE FUNCTION public.feed_priority_topic_matches(
  p_priority_topics text[],
  p_topics text[],
  p_hashtags text[],
  p_body text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  v_topic text;
  v_text text := pg_catalog.lower(pg_catalog.concat_ws(
    ' ',
    COALESCE(p_body, ''),
    pg_catalog.array_to_string(COALESCE(p_topics, ARRAY[]::text[]), ' '),
    pg_catalog.array_to_string(COALESCE(p_hashtags, ARRAY[]::text[]), ' ')
  ));
BEGIN
  FOREACH v_topic IN ARRAY COALESCE(p_priority_topics, ARRAY[]::text[])
  LOOP
    v_topic := public.feed_normalize_topic(v_topic);
    IF (v_topic = 'news' AND v_text ~ '(actualité|actualite|information|journal|news)')
      OR (v_topic = 'technology' AND v_text ~ '(tech|technologie|informatique|numérique|numerique)')
      OR (v_topic = 'sport' AND v_text ~ '(sport|football|basket|tennis|rugby|fitness)')
      OR (v_topic = 'art' AND v_text ~ '(art|dessin|peinture|photo|sculpture|illustration)')
      OR (v_topic = 'music' AND v_text ~ '(music|musique|chanson|concert|album|rap|rock)')
      OR (v_topic = 'cooking' AND v_text ~ '(cooking|cuisine|recette|restaurant|gastronomie)')
      OR (v_topic = 'travel' AND v_text ~ '(travel|voyage|tourisme|vacances|destination)')
      OR (v_topic = 'science' AND v_text ~ '(science|recherche|physique|biologie|espace)')
      OR (v_topic = 'education' AND v_text ~ '(éducation|education|école|ecole|université|universite|apprentissage|pédagogie|pedagogie)')
      OR (v_topic = 'wellbeing' AND v_text ~ '(bien-être|bien etre|wellbeing|psychologie|santé mentale|sante mentale|méditation|meditation|mindfulness)')
      OR (v_topic = 'fashion' AND v_text ~ '(fashion|mode|vêtement|vetement|style)')
      OR (v_topic = 'cinema' AND v_text ~ '(cinema|cinéma|film|série|serie)')
      OR (v_topic = 'literature' AND v_text ~ '(literature|littérature|livre|roman|lecture)')
      OR (v_topic = 'gaming' AND v_text ~ '(gaming|jeu vidéo|jeux vidéo|gameplay|esport)')
      OR (v_topic = 'nature' AND v_text ~ '(nature|animal|écologie|ecologie|environnement)')
      OR (v_topic = 'comedy' AND v_text ~ '(humour|comédie|comedie|drôle|drole)')
    THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.feed_priority_topic_matches(text[], text[], text[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_priority_topic_matches(text[], text[], text[], text)
  TO service_role;

CREATE INDEX IF NOT EXISTS user_interests_explicit_category_lookup
  ON public.user_interests(user_id, weight DESC, updated_at DESC)
  WHERE explicit AND interest_type = 'category';

CREATE OR REPLACE FUNCTION public.partner_media_for_zone(
  p_scope text,p_kind text,p_country text,p_region text,p_city text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=''
SET statement_timeout='1500ms'
AS $function$
 WITH viewer AS MATERIALIZED (
   SELECT
     session.user_id,
     COALESCE(preferences.weight_news,30) AS news_weight,
     COALESCE(preferences.priority_topics,ARRAY[]::text[])
       || COALESCE((
         SELECT pg_catalog.array_agg(interests.interest_value ORDER BY interests.weight DESC,interests.updated_at DESC,interests.interest_value)
         FROM public.user_interests AS interests
         WHERE interests.user_id=session.user_id
           AND interests.explicit
           AND interests.interest_type='category'
       ),ARRAY[]::text[]) AS topics
   FROM (SELECT (SELECT auth.uid()) AS user_id) AS session
   LEFT JOIN public.user_feed_preferences AS preferences
     ON preferences.user_id=session.user_id
 ), normalized_topics AS MATERIALIZED (
   SELECT
     public.feed_normalize_topic(raw_topic.value) AS topic,
     pg_catalog.min(raw_topic.position)::integer AS priority_rank
   FROM viewer
   CROSS JOIN LATERAL pg_catalog.unnest(viewer.topics)
     WITH ORDINALITY AS raw_topic(value,position)
   GROUP BY public.feed_normalize_topic(raw_topic.value)
 ), eligible AS (
   SELECT m.id,m.discussion_id,m.title,
     CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END excerpt,
     m.canonical_url,m.kind,
     CASE WHEN p.allow_youtube_embed THEN m.youtube_id END youtube_id,
     m.thumbnail_url,m.published_at,p.name source_name,p.country,p.region,p.city,
     p.website_host,p.editorial_category,viewer.news_weight,
     COALESCE((
       SELECT topic.priority_rank
       FROM normalized_topics AS topic
       WHERE topic.topic=CASE WHEN p.editorial_category='general' THEN 'news' ELSE p.editorial_category END
     ),1000) AS preference_rank,
     CASE
       WHEN p.country=p_country
         AND public.media_place_key(p_region)<>''
         AND public.media_place_key(p.region)=public.media_place_key(p_region)
       THEN CASE
         WHEN public.media_place_key(p_city)<>''
           AND public.media_place_key(p.city)=public.media_place_key(p_city)
         THEN 0 ELSE 1
       END
       WHEN p.country='FR'
         AND public.media_place_key(p.region)=''
         AND public.media_place_key(p.city)=''
       THEN 2 ELSE 3
     END proximity
   FROM public.partner_media_items AS m
   JOIN public.media_partners AS p ON p.id=m.partner_id
   CROSS JOIN viewer
   WHERE viewer.user_id IS NOT NULL
     AND p_scope IN ('nearby','city','region','france')
     AND p_kind IN ('all','article','video')
     AND p.active
     AND p.rights_until>now()
     AND m.expires_at>now()
     AND m.published_at<=now()
     AND m.published_at>now()-interval '36 hours'
     AND m.moderated
     AND (p_kind='all' OR m.kind=p_kind)
 ), deduplicated AS (
   SELECT *,
     pg_catalog.row_number() OVER (
       PARTITION BY canonical_url
       ORDER BY preference_rank,proximity,published_at DESC,id
     ) duplicate_number
   FROM eligible
   WHERE (p_scope='france' AND country='FR')
     OR (p_scope='nearby' AND proximity<=2)
     OR (p_scope='region' AND proximity<=1)
     OR (p_scope='city' AND proximity=0)
 ), publisher_diversified AS (
   SELECT *,
     pg_catalog.row_number() OVER (
       PARTITION BY website_host,editorial_category
       ORDER BY preference_rank,proximity,published_at DESC,id
     ) publisher_number
   FROM deduplicated
   WHERE duplicate_number=1
 ), category_balanced AS (
   SELECT *,
     pg_catalog.row_number() OVER (
       PARTITION BY editorial_category
       ORDER BY preference_rank,
         CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,
         published_at DESC,id
     ) category_number
   FROM publisher_diversified
   WHERE publisher_number<=3
 ), ordered AS (
   SELECT id,discussion_id,title,excerpt,canonical_url,kind,youtube_id,
     thumbnail_url,published_at,source_name,country,region,city,
     editorial_category,news_weight,
     CASE proximity
       WHEN 0 THEN 'city'
       WHEN 1 THEN 'region'
       WHEN 2 THEN 'national'
       ELSE 'other'
     END proximity,
     CASE
       WHEN preference_rank<1000 THEN 'declared_interest'
       WHEN p_scope='nearby' AND proximity<=1 THEN 'local_relevance'
       ELSE 'positive_editorial_diversity'
     END rank_reason,
     pg_catalog.row_number() OVER (
       ORDER BY category_number,preference_rank,
         CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,
         CASE editorial_category
           WHEN 'general' THEN 0
           WHEN 'science' THEN 1
           WHEN 'education' THEN 2
           WHEN 'wellbeing' THEN 3
           WHEN 'sport' THEN 4
           WHEN 'music' THEN 5
           ELSE 6
         END,
         published_at DESC,id
     ) position
   FROM category_balanced
 ), selected AS (
   SELECT *
   FROM ordered
   WHERE position<=CASE
     WHEN news_weight<=0 THEN 0
     ELSE LEAST(12,GREATEST(2,2+pg_catalog.ceil(news_weight/10.0)::integer))
   END
 )
 SELECT COALESCE(
   pg_catalog.jsonb_agg(to_jsonb(selected)-'position'-'news_weight' ORDER BY position),
   '[]'::jsonb
 )
 FROM selected;
$function$;

REVOKE ALL ON FUNCTION public.partner_media_for_zone(text,text,text,text,text)
  FROM PUBLIC,anon,authenticated;