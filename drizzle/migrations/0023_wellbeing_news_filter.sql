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
     AND pg_catalog.lower(m.title||' '||COALESCE(m.excerpt,'')) !~* '\m(meurtre|meurtrier|homicide|assassinat|assassin|viol|viols|violeur|agression sexuelle|agresse|poignard|tue|tuerie|fusillade|cadavre|feminicide|féminicide|infanticide|parricide|terrorisme|attentat|enlevement|enlèvement|kidnapping|tortur|mutile|mutilé|demembr|démembr|lynch|massacr|corps sans vie|coups de couteau|coups de feu|mort violente|retrouve mort|retrouvé mort|retrouvée morte|frappe a mort|frappé à mort|frappée à mort|battu a mort|battue à mort)'
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