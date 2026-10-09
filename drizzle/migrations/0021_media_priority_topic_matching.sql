-- Analyse le contenu (titre + extrait + catégorie) d'un média partenaire et renvoie les sujets détectés,
-- dans le vocabulaire des « Sujets prioritaires » du fil.
CREATE OR REPLACE FUNCTION public.partner_media_detect_topics(
  p_title text, p_excerpt text, p_category text
) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $function$
  WITH src AS (
    SELECT pg_catalog.lower(pg_catalog.concat_ws(' ', COALESCE(p_title,''), COALESCE(p_excerpt,''))) AS t
  )
  SELECT ARRAY(
    SELECT DISTINCT topic FROM (
      SELECT CASE WHEN p_category='general' OR p_category IS NULL THEN 'news' ELSE p_category END AS topic
      UNION ALL SELECT 'technology' FROM src WHERE t ~ '(technolog|informatique|numérique|numerique|intelligence artificielle|\mia\M|smartphone|logiciel|startup|cyber|robot)'
      UNION ALL SELECT 'sport' FROM src WHERE t ~ '(sport|football|\mfoot\M|basket|tennis|rugby|cyclis|handball|ligue 1|champion|olympi|athlét|athlet|formule 1)'
      UNION ALL SELECT 'art' FROM src WHERE t ~ '(exposition|musée|musee|peinture|sculpt|artiste|galerie|photograph|street art|illustrat)'
      UNION ALL SELECT 'music' FROM src WHERE t ~ '(musique|music|concert|festival|chanteu|chanson|album|rappeur|\mrap\M|orchestre|opéra|opera)'
      UNION ALL SELECT 'cooking' FROM src WHERE t ~ '(cuisine|recette|restaurant|gastronom|boulang|pâtiss|patiss|fromage)'
      UNION ALL SELECT 'travel' FROM src WHERE t ~ '(voyage|tourism|touriste|vacances|destination|randonn|patrimoine|séjour|sejour)'
      UNION ALL SELECT 'science' FROM src WHERE t ~ '(science|chercheu|recherche|physique|biolog|astronom|nasa|spatial|découverte|decouverte)'
      UNION ALL SELECT 'education' FROM src WHERE t ~ '(éducation|education|école|ecole|collège|lycée|lycee|universit|étudiant|etudiant|enseign|apprentissage)'
      UNION ALL SELECT 'wellbeing' FROM src WHERE t ~ '(bien-être|bien être|santé|sante|psycholog|méditation|meditation|sommeil|stress|nutrition|yoga)'
      UNION ALL SELECT 'fashion' FROM src WHERE t ~ '(\mmode\M|fashion|défilé|defile|vêtement|vetement|couture)'
      UNION ALL SELECT 'cinema' FROM src WHERE t ~ '(cinéma|cinema|\mfilm|\msérie|acteur|actrice|réalisat|realisat|netflix)'
      UNION ALL SELECT 'literature' FROM src WHERE t ~ '(\mlivre|roman\M|littérat|litterat|écrivain|ecrivain|librairie|bibliothèque|bibliotheque)'
      UNION ALL SELECT 'gaming' FROM src WHERE t ~ '(jeu vidéo|jeux vidéo|jeu video|jeux video|gaming|esport|playstation|nintendo|xbox)'
      UNION ALL SELECT 'nature' FROM src WHERE t ~ '(nature|animal|animaux|écolog|ecolog|environnement|climat|forêt|foret|biodiversit)'
    ) d
  );
$function$;
REVOKE ALL ON FUNCTION public.partner_media_detect_topics(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_media_detect_topics(text,text,text) TO service_role;

-- Ordre : sujets prioritaires explicites, puis sujets appris (réactions/commentaires actus 30 j),
-- puis proximité et diversité éditoriale.
CREATE OR REPLACE FUNCTION public.partner_media_for_zone(
  p_scope text,p_kind text,p_country text,p_region text,p_city text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=''
SET statement_timeout='1500ms'
AS $function$
 WITH viewer AS MATERIALIZED (
   SELECT session.user_id,
     COALESCE(preferences.weight_news,30) AS news_weight,
     COALESCE(preferences.priority_topics,ARRAY[]::text[])
       || COALESCE((
         SELECT pg_catalog.array_agg(interests.interest_value ORDER BY interests.weight DESC,interests.updated_at DESC,interests.interest_value)
         FROM public.user_interests AS interests
         WHERE interests.user_id=session.user_id AND interests.explicit AND interests.interest_type='category'
       ),ARRAY[]::text[]) AS topics
   FROM (SELECT (SELECT auth.uid()) AS user_id) AS session
   LEFT JOIN public.user_feed_preferences AS preferences ON preferences.user_id=session.user_id
 ), explicit_topics AS MATERIALIZED (
   SELECT public.feed_normalize_topic(raw_topic.value) AS topic,
     pg_catalog.min(raw_topic.position)::integer AS priority_rank
   FROM viewer
   CROSS JOIN LATERAL pg_catalog.unnest(viewer.topics) WITH ORDINALITY AS raw_topic(value,position)
   GROUP BY public.feed_normalize_topic(raw_topic.value)
 ), engaged_threads AS MATERIALIZED (
   SELECT r.thread_id FROM public.news_reactions r, viewer
   WHERE r.user_id=viewer.user_id AND r.created_at>now()-interval '30 days' AND r.reaction NOT IN ('sad','angry')
   UNION
   SELECT c.thread_id FROM public.news_comments c, viewer
   WHERE c.user_id=viewer.user_id AND c.created_at>now()-interval '30 days'
 ), learned_topics AS MATERIALIZED (
   SELECT t.topic, (100 + pg_catalog.row_number() OVER (ORDER BY pg_catalog.count(*) DESC, t.topic))::integer AS priority_rank
   FROM engaged_threads e
   JOIN public.partner_media_items mi ON mi.discussion_id=e.thread_id
   JOIN public.media_partners mp ON mp.id=mi.partner_id
   CROSS JOIN LATERAL pg_catalog.unnest(public.partner_media_detect_topics(mi.title,mi.excerpt,mp.editorial_category)) AS t(topic)
   WHERE t.topic NOT IN (SELECT topic FROM explicit_topics)
   GROUP BY t.topic
 ), normalized_topics AS MATERIALIZED (
   SELECT topic, priority_rank FROM explicit_topics
   UNION ALL SELECT topic, priority_rank FROM learned_topics
 ), eligible AS (
   SELECT m.id,m.discussion_id,m.title,
     CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END excerpt,
     m.canonical_url,m.kind,
     CASE WHEN p.allow_youtube_embed THEN m.youtube_id END youtube_id,
     m.thumbnail_url,m.published_at,p.name source_name,p.country,p.region,p.city,
     p.website_host,p.editorial_category,viewer.news_weight,
     COALESCE((
       SELECT pg_catalog.min(topic.priority_rank) FROM normalized_topics AS topic
       WHERE topic.topic = ANY(public.partner_media_detect_topics(m.title,m.excerpt,p.editorial_category))
     ),1000) AS preference_rank,
     CASE
       WHEN p.country=p_country AND public.media_place_key(p_region)<>''
         AND public.media_place_key(p.region)=public.media_place_key(p_region)
       THEN CASE WHEN public.media_place_key(p_city)<>''
           AND public.media_place_key(p.city)=public.media_place_key(p_city) THEN 0 ELSE 1 END
       WHEN p.country='FR' AND public.media_place_key(p.region)='' AND public.media_place_key(p.city)='' THEN 2
       ELSE 3
     END proximity
   FROM public.partner_media_items AS m
   JOIN public.media_partners AS p ON p.id=m.partner_id
   CROSS JOIN viewer
   WHERE viewer.user_id IS NOT NULL
     AND p_scope IN ('nearby','city','region','france')
     AND p_kind IN ('all','article','video')
     AND p.active AND p.rights_until>now()
     AND m.expires_at>now() AND m.published_at<=now()
     AND m.published_at>now()-interval '36 hours'
     AND m.moderated
     AND (p_kind='all' OR m.kind=p_kind)
 ), deduplicated AS (
   SELECT *, pg_catalog.row_number() OVER (PARTITION BY canonical_url ORDER BY preference_rank,proximity,published_at DESC,id) duplicate_number
   FROM eligible
   WHERE (p_scope='france' AND country='FR') OR (p_scope='nearby' AND proximity<=2)
     OR (p_scope='region' AND proximity<=1) OR (p_scope='city' AND proximity=0)
 ), publisher_diversified AS (
   SELECT *, pg_catalog.row_number() OVER (PARTITION BY website_host,editorial_category ORDER BY preference_rank,proximity,published_at DESC,id) publisher_number
   FROM deduplicated WHERE duplicate_number=1
 ), category_balanced AS (
   SELECT *, pg_catalog.row_number() OVER (
       PARTITION BY (preference_rank<1000), editorial_category
       ORDER BY preference_rank, CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END, published_at DESC,id
     ) category_number
   FROM publisher_diversified WHERE publisher_number<=3
 ), ordered AS (
   SELECT id,discussion_id,title,excerpt,canonical_url,kind,youtube_id,
     thumbnail_url,published_at,source_name,country,region,city,editorial_category,news_weight,
     CASE proximity WHEN 0 THEN 'city' WHEN 1 THEN 'region' WHEN 2 THEN 'national' ELSE 'other' END proximity,
     CASE
       WHEN preference_rank<100 THEN 'declared_interest'
       WHEN preference_rank<1000 THEN 'learned_interest'
       WHEN p_scope='nearby' AND proximity<=1 THEN 'local_relevance'
       ELSE 'positive_editorial_diversity'
     END rank_reason,
     pg_catalog.row_number() OVER (
       ORDER BY CASE WHEN preference_rank<100 THEN 0 WHEN preference_rank<1000 THEN 1 ELSE 2 END,
         category_number,preference_rank,
         CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,
         published_at DESC,id
     ) position
   FROM category_balanced
 ), selected AS (
   SELECT * FROM ordered
   WHERE position<=CASE WHEN news_weight<=0 THEN 0
     ELSE LEAST(12,GREATEST(2,2+pg_catalog.ceil(news_weight/10.0)::integer)) END
 )
 SELECT COALESCE(pg_catalog.jsonb_agg(to_jsonb(selected)-'position'-'news_weight' ORDER BY position),'[]'::jsonb)
 FROM selected;
$function$;

REVOKE ALL ON FUNCTION public.partner_media_for_zone(text,text,text,text,text) FROM PUBLIC,anon,authenticated;