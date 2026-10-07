BEGIN;

-- The operator confirmed that ForSure may surface these publisher RSS feeds.
-- Keep each edition explicit so a regional feed can never be relabelled as
-- national, and keep excerpts disabled unless separately granted.
WITH configured(source_key,name,website_host,region,city) AS (
  VALUES
    ('le-monde','Le Monde','www.lemonde.fr',NULL::text,NULL::text),
    ('le-figaro','Le Figaro','www.lefigaro.fr',NULL,NULL),
    ('liberation','Libération','www.liberation.fr',NULL,NULL),
    ('humanite','L’Humanité','www.humanite.fr',NULL,NULL),
    ('ouest-france','Ouest-France — Une générale','www.ouest-france.fr',NULL,NULL),
    ('le-parisien','Le Parisien','www.leparisien.fr',NULL,NULL),
    ('est-republicain','L’Est Républicain — Une générale','www.estrepublicain.fr',NULL,NULL),
    ('la-depeche','La Dépêche du Midi','www.ladepeche.fr','Occitanie',NULL),
    ('midi-libre','Midi Libre','www.midilibre.fr','Occitanie',NULL),
    ('lindependant','L’Indépendant','www.lindependant.fr','Occitanie',NULL),
    ('dna','Dernières Nouvelles d’Alsace','www.dna.fr','Grand Est',NULL),
    ('lalsace','L’Alsace','www.lalsace.fr','Grand Est',NULL),
    ('republicain-lorrain','Le Républicain Lorrain','www.republicain-lorrain.fr','Grand Est',NULL),
    ('bien-public','Le Bien Public','www.bienpublic.com','Bourgogne-Franche-Comté',NULL),
    ('jsl','Le Journal de Saône-et-Loire','www.lejsl.com','Bourgogne-Franche-Comté',NULL),
    ('nice-matin','Nice-Matin','www.nicematin.com','Provence-Alpes-Côte d’Azur',NULL),
    ('actu-auvergne-rhone-alpes','actu.fr — Auvergne-Rhône-Alpes','actu.fr','Auvergne-Rhône-Alpes',NULL),
    ('actu-bourgogne-franche-comte','actu.fr — Bourgogne-Franche-Comté','actu.fr','Bourgogne-Franche-Comté',NULL),
    ('actu-bretagne','actu.fr — Bretagne','actu.fr','Bretagne',NULL),
    ('actu-centre-val-de-loire','actu.fr — Centre-Val de Loire','actu.fr','Centre-Val de Loire',NULL),
    ('actu-corse','actu.fr — Corse','actu.fr','Corse',NULL),
    ('actu-grand-est','actu.fr — Grand Est','actu.fr','Grand Est',NULL),
    ('actu-hauts-de-france','actu.fr — Hauts-de-France','actu.fr','Hauts-de-France',NULL),
    ('actu-ile-de-france','actu.fr — Île-de-France','actu.fr','Île-de-France',NULL),
    ('actu-normandie','actu.fr — Normandie','actu.fr','Normandie',NULL),
    ('actu-nouvelle-aquitaine','actu.fr — Nouvelle-Aquitaine','actu.fr','Nouvelle-Aquitaine',NULL),
    ('actu-occitanie','actu.fr — Occitanie','actu.fr','Occitanie',NULL),
    ('actu-pays-de-la-loire','actu.fr — Pays de la Loire','actu.fr','Pays de la Loire',NULL),
    ('actu-provence-alpes-cote-d-azur','actu.fr — Provence-Alpes-Côte d’Azur','actu.fr','Provence-Alpes-Côte d’Azur',NULL),
    ('actu-martinique','actu.fr — Martinique','actu.fr','Martinique',NULL),
    ('actu-guyane','actu.fr — Guyane','actu.fr','Guyane',NULL),
    ('actu-la-reunion','actu.fr — La Réunion','actu.fr','La Réunion',NULL),
    ('actu-mayotte','actu.fr — Mayotte','actu.fr','Mayotte',NULL),
    ('france-antilles-guadeloupe','France-Antilles — Guadeloupe','www.guadeloupe.franceantilles.fr','Guadeloupe',NULL),
    ('la-provence-marseille','La Provence — Marseille','www.laprovence.com','Provence-Alpes-Côte d’Azur','Marseille'),
    ('le-progres-rhone','Le Progrès — Rhône','www.leprogres.fr','Auvergne-Rhône-Alpes',NULL),
    ('le-progres-jura','Le Progrès — Jura','www.leprogres.fr','Bourgogne-Franche-Comté',NULL),
    ('corse-net-infos','Corse Net Infos','www.corsenetinfos.corsica','Corse',NULL),
    ('mayotte-hebdo','Mayotte Hebdo','www.mayottehebdo.com','Mayotte',NULL),
    ('imaz-press-reunion','Imaz Press Réunion','imazpress.com','La Réunion',NULL),
    ('rci-guadeloupe','RCI — Guadeloupe','rci.fm','Guadeloupe',NULL),
    ('rci-martinique','RCI — Martinique','rci.fm','Martinique',NULL),
    ('france-guyane-vie-locale','France-Guyane — Vie locale','www.franceguyane.fr','Guyane',NULL),
    ('france-guyane-faits-divers','France-Guyane — Faits divers','www.franceguyane.fr','Guyane',NULL)
), inserted AS (
  INSERT INTO public.media_partners(name,website_host,country,region,city,agreement_reference,rights_until,allow_excerpt,allow_youtube_embed,active)
  SELECT c.name,c.website_host,'FR',c.region,c.city,
    'operator-confirmed:2026-10-07:'||c.source_key,
    timestamptz '2027-10-07 23:59:59+00',false,false,true
  FROM configured c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.media_partners p
    WHERE p.agreement_reference='operator-confirmed:2026-10-07:'||c.source_key
  )
  RETURNING id,agreement_reference
)
INSERT INTO public.partner_rss_sources(partner_id,source_key,enabled,auto_publish,next_fetch_at)
SELECT p.id,c.source_key,true,true,now()
FROM configured c
JOIN public.media_partners p
  ON p.agreement_reference='operator-confirmed:2026-10-07:'||c.source_key
ON CONFLICT(partner_id,source_key) DO UPDATE SET
  enabled=true,auto_publish=true,next_fetch_at=now(),lease_token=NULL,lease_until=NULL;

-- News is not advertising. Adult-ad eligibility must not hide publisher news.
CREATE OR REPLACE FUNCTION public.partner_media_for_zone(
  p_scope text,p_kind text,p_country text,p_region text,p_city text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='1500ms' AS $$
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
     AND (p_kind='all' OR m.kind=p_kind)
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

COMMIT;
