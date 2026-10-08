BEGIN;

-- Keep location and editorial intent separate. A national science source is
-- still eligible beside nearby news, and the viewer's feed preferences only
-- influence ordering; they never grant publication rights.
ALTER TABLE public.media_partners
  ADD COLUMN IF NOT EXISTS editorial_category text NOT NULL DEFAULT 'general';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.media_partners'::regclass
      AND conname='media_partners_editorial_category_check'
  ) THEN
    ALTER TABLE public.media_partners
      ADD CONSTRAINT media_partners_editorial_category_check
      CHECK (editorial_category IN ('general','science','music','education','wellbeing'));
  END IF;
END
$constraint$;

CREATE INDEX IF NOT EXISTS media_partners_editorial_active
  ON public.media_partners(editorial_category,country,region)
  WHERE active;

-- These exact feeds were reviewed on 2026-10-08. Metadata only is ingested:
-- titles, canonical links and safe thumbnails; excerpts and embeds stay off.
WITH configured(source_key,name,website_host,editorial_category) AS (
  VALUES
    ('cnrs-journal','Le Journal du CNRS','lejournal.cnrs.fr','science'),
    ('futura-sciences','Futura','www.futura-sciences.com','science'),
    ('pour-la-science','Pour la Science','www.pourlascience.fr','science'),
    ('le-monde-sciences','Le Monde — Sciences','www.lemonde.fr','science'),
    ('the-conversation-education','The Conversation — Éducation','theconversation.com','education'),
    ('le-monde-education','Le Monde — Éducation','www.lemonde.fr','education'),
    ('cafe-pedagogique','Le Café pédagogique','www.cafepedagogique.net','education'),
    ('le-monde-musiques','Le Monde — Musiques','www.lemonde.fr','music'),
    ('france-musique','France Musique','www.radiofrance.fr','music'),
    ('tsugi','Tsugi','www.tsugi.fr','music'),
    ('the-conversation-sante','The Conversation — Santé','theconversation.com','wellbeing'),
    ('psychologies','Psychologies','www.psychologies.com','wellbeing'),
    ('sante-publique-france-sante-mentale','Santé publique France — Santé mentale','www.santepubliquefrance.fr','wellbeing')
)
UPDATE public.media_partners AS partner
SET name=configured.name,
    website_host=configured.website_host,
    editorial_category=configured.editorial_category,
    country='FR',
    region=NULL,
    city=NULL,
    rights_until=greatest(partner.rights_until,timestamptz '2027-10-08 23:59:59+00'),
    allow_excerpt=false,
    allow_youtube_embed=false,
    active=true
FROM configured
WHERE partner.agreement_reference='operator-confirmed:2026-10-08:'||configured.source_key;

WITH configured(source_key,name,website_host,editorial_category) AS (
  VALUES
    ('cnrs-journal','Le Journal du CNRS','lejournal.cnrs.fr','science'),
    ('futura-sciences','Futura','www.futura-sciences.com','science'),
    ('pour-la-science','Pour la Science','www.pourlascience.fr','science'),
    ('le-monde-sciences','Le Monde — Sciences','www.lemonde.fr','science'),
    ('the-conversation-education','The Conversation — Éducation','theconversation.com','education'),
    ('le-monde-education','Le Monde — Éducation','www.lemonde.fr','education'),
    ('cafe-pedagogique','Le Café pédagogique','www.cafepedagogique.net','education'),
    ('le-monde-musiques','Le Monde — Musiques','www.lemonde.fr','music'),
    ('france-musique','France Musique','www.radiofrance.fr','music'),
    ('tsugi','Tsugi','www.tsugi.fr','music'),
    ('the-conversation-sante','The Conversation — Santé','theconversation.com','wellbeing'),
    ('psychologies','Psychologies','www.psychologies.com','wellbeing'),
    ('sante-publique-france-sante-mentale','Santé publique France — Santé mentale','www.santepubliquefrance.fr','wellbeing')
)
INSERT INTO public.media_partners(
  name,website_host,country,region,city,agreement_reference,rights_until,
  allow_excerpt,allow_youtube_embed,active,editorial_category
)
SELECT configured.name,configured.website_host,'FR',NULL,NULL,
  'operator-confirmed:2026-10-08:'||configured.source_key,
  timestamptz '2027-10-08 23:59:59+00',false,false,true,configured.editorial_category
FROM configured
WHERE NOT EXISTS (
  SELECT 1 FROM public.media_partners AS partner
  WHERE partner.agreement_reference='operator-confirmed:2026-10-08:'||configured.source_key
);

WITH configured(source_key) AS (
  VALUES
    ('cnrs-journal'),('futura-sciences'),('pour-la-science'),('le-monde-sciences'),
    ('the-conversation-education'),('le-monde-education'),('cafe-pedagogique'),
    ('le-monde-musiques'),('france-musique'),('tsugi'),
    ('the-conversation-sante'),('psychologies'),('sante-publique-france-sante-mentale')
)
INSERT INTO public.partner_rss_sources(partner_id,source_key,enabled,auto_publish,next_fetch_at)
SELECT partner.id,configured.source_key,true,true,to_timestamp(0)
FROM configured
JOIN public.media_partners AS partner
  ON partner.agreement_reference='operator-confirmed:2026-10-08:'||configured.source_key
ON CONFLICT(partner_id,source_key) DO UPDATE SET
  enabled=true,
  auto_publish=true,
  etag=NULL,
  last_modified=NULL,
  -- The first worker batch must contain these newly enabled lanes instead of
  -- waiting behind older general-news sources that are already overdue.
  next_fetch_at=to_timestamp(0),
  lease_token=NULL,
  lease_until=NULL;

-- One item from every available editorial lane is considered before the
-- second item from any lane. This prevents high-volume general/local sources
-- from pushing science, music, education or wellbeing out of the first page.
CREATE OR REPLACE FUNCTION public.partner_media_for_zone(
  p_scope text,p_kind text,p_country text,p_region text,p_city text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=''
SET statement_timeout='1500ms'
AS $$
 WITH eligible AS (
   SELECT m.id,m.discussion_id,m.title,
     CASE WHEN p.allow_excerpt THEN m.excerpt ELSE '' END excerpt,
     m.canonical_url,m.kind,
     CASE WHEN p.allow_youtube_embed THEN m.youtube_id END youtube_id,
     m.thumbnail_url,m.published_at,p.name source_name,p.country,p.region,p.city,
     p.website_host,p.editorial_category,
     p.editorial_category = ANY(coalesce((
       SELECT preferences.priority_topics
       FROM public.user_feed_preferences AS preferences
       WHERE preferences.user_id=(SELECT auth.uid())
     ),ARRAY[]::text[])) preferred,
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
   WHERE (SELECT auth.uid()) IS NOT NULL
     AND p_scope IN ('nearby','city','region','france')
     AND p_kind IN ('all','article','video')
     AND p.active
     AND p.rights_until>now()
     AND m.expires_at>now()
     AND m.published_at<=now()
     AND m.moderated
     AND (p_kind='all' OR m.kind=p_kind)
 ), deduplicated AS (
   SELECT *,
     row_number() OVER (
       PARTITION BY canonical_url
       ORDER BY preferred DESC,proximity,published_at DESC,id
     ) duplicate_number
   FROM eligible
   WHERE (p_scope='france' AND country='FR')
     OR (p_scope='nearby' AND proximity<=2)
     OR (p_scope='region' AND proximity<=1)
     OR (p_scope='city' AND proximity=0)
 ), publisher_diversified AS (
   SELECT *,
     row_number() OVER (
       PARTITION BY website_host,editorial_category
       ORDER BY preferred DESC,proximity,published_at DESC,id
     ) publisher_number
   FROM deduplicated
   WHERE duplicate_number=1
 ), category_balanced AS (
   SELECT *,
     row_number() OVER (
       PARTITION BY editorial_category
       ORDER BY preferred DESC,
         CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,
         published_at DESC,id
     ) category_number
   FROM publisher_diversified
   WHERE publisher_number<=3
 ), selected AS (
   SELECT id,discussion_id,title,excerpt,canonical_url,kind,youtube_id,
     thumbnail_url,published_at,source_name,country,region,city,
     editorial_category,
     CASE proximity
       WHEN 0 THEN 'city'
       WHEN 1 THEN 'region'
       WHEN 2 THEN 'national'
       ELSE 'other'
     END proximity,
     row_number() OVER (
       ORDER BY category_number,
         CASE WHEN preferred THEN 0 ELSE 1 END,
         CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,
         CASE editorial_category
           WHEN 'general' THEN 0
           WHEN 'science' THEN 1
           WHEN 'education' THEN 2
           WHEN 'wellbeing' THEN 3
           WHEN 'music' THEN 4
           ELSE 5
         END,
         published_at DESC,id
     ) position
   FROM category_balanced
   ORDER BY category_number,
     CASE WHEN preferred THEN 0 ELSE 1 END,
     CASE WHEN p_scope='nearby' THEN proximity ELSE 0 END,
     CASE editorial_category
       WHEN 'general' THEN 0
       WHEN 'science' THEN 1
       WHEN 'education' THEN 2
       WHEN 'wellbeing' THEN 3
       WHEN 'music' THEN 4
       ELSE 5
     END,
     published_at DESC,id
   LIMIT 16
 )
 SELECT coalesce(
   jsonb_agg(to_jsonb(selected)-'position' ORDER BY position),
   '[]'::jsonb
 )
 FROM selected;
$$;

REVOKE ALL ON FUNCTION public.partner_media_for_zone(text,text,text,text,text)
  FROM PUBLIC,anon,authenticated;

-- The hourly worker remains the durable fallback. This immediate enqueue
-- makes the first specialized batch available as soon as the migration lands.
SELECT private.partner_rss_daily_tick();

COMMIT;
