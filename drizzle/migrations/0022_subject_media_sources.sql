BEGIN;

-- New subject lanes so every feed priority topic has dedicated sources.
ALTER TABLE public.media_partners
  DROP CONSTRAINT IF EXISTS media_partners_editorial_category_check;

ALTER TABLE public.media_partners
  ADD CONSTRAINT media_partners_editorial_category_check
  CHECK (editorial_category IN (
    'general','science','music','education','wellbeing','sport',
    'technology','gaming','cinema','literature','travel','nature','art','fashion'
  ));

-- Publisher metadata only: title, canonical link and safe thumbnail. Excerpts
-- and third-party embeds remain disabled unless a separate right grants them.
WITH configured(source_key,name,website_host,editorial_category) AS (
  VALUES
    ('zero1net','01net','www.01net.com','technology'),
    ('numerama','Numerama','www.numerama.com','technology'),
    ('le-monde-pixels','Le Monde — Pixels','www.lemonde.fr','technology'),
    ('gamekult','Gamekult','www.gamekult.com','gaming'),
    ('jeuxvideo-com','Jeuxvideo.com','www.jeuxvideo.com','gaming'),
    ('franceinfo-cinema','franceinfo — Cinéma','www.franceinfo.fr','cinema'),
    ('livres-hebdo','Livres Hebdo','www.livreshebdo.fr','literature'),
    ('franceinfo-livres','franceinfo — Livres','www.franceinfo.fr','literature'),
    ('voyageurs-du-net','Voyageurs du Net','www.voyageurs-du-net.com','travel'),
    ('routard','Le Routard','www.routard.com','travel'),
    ('reporterre','Reporterre','reporterre.net','nature'),
    ('natura-sciences','Natura Sciences','www.natura-sciences.com','nature'),
    ('consoglobe','Consoglobe','www.consoglobe.com','nature'),
    ('le-monde-culture','Le Monde — Culture','www.lemonde.fr','art'),
    ('beaux-arts','Beaux Arts Magazine','www.beauxarts.com','art'),
    ('grazia','Grazia','www.grazia.fr','fashion')
)
UPDATE public.media_partners AS partner
SET name=configured.name,
    website_host=configured.website_host,
    editorial_category=configured.editorial_category,
    country='FR',
    region=NULL,
    city=NULL,
    rights_until=greatest(partner.rights_until,timestamptz '2027-10-09 23:59:59+00'),
    allow_excerpt=false,
    allow_youtube_embed=false,
    active=true
FROM configured
WHERE partner.agreement_reference='operator-confirmed:2026-10-09:'||configured.source_key;

WITH configured(source_key,name,website_host,editorial_category) AS (
  VALUES
    ('zero1net','01net','www.01net.com','technology'),
    ('numerama','Numerama','www.numerama.com','technology'),
    ('le-monde-pixels','Le Monde — Pixels','www.lemonde.fr','technology'),
    ('gamekult','Gamekult','www.gamekult.com','gaming'),
    ('jeuxvideo-com','Jeuxvideo.com','www.jeuxvideo.com','gaming'),
    ('franceinfo-cinema','franceinfo — Cinéma','www.franceinfo.fr','cinema'),
    ('livres-hebdo','Livres Hebdo','www.livreshebdo.fr','literature'),
    ('franceinfo-livres','franceinfo — Livres','www.franceinfo.fr','literature'),
    ('voyageurs-du-net','Voyageurs du Net','www.voyageurs-du-net.com','travel'),
    ('routard','Le Routard','www.routard.com','travel'),
    ('reporterre','Reporterre','reporterre.net','nature'),
    ('natura-sciences','Natura Sciences','www.natura-sciences.com','nature'),
    ('consoglobe','Consoglobe','www.consoglobe.com','nature'),
    ('le-monde-culture','Le Monde — Culture','www.lemonde.fr','art'),
    ('beaux-arts','Beaux Arts Magazine','www.beauxarts.com','art'),
    ('grazia','Grazia','www.grazia.fr','fashion')
)
INSERT INTO public.media_partners(
  name,website_host,country,region,city,agreement_reference,rights_until,
  allow_excerpt,allow_youtube_embed,active,editorial_category
)
SELECT configured.name,configured.website_host,'FR',NULL,NULL,
  'operator-confirmed:2026-10-09:'||configured.source_key,
  timestamptz '2027-10-09 23:59:59+00',false,false,true,configured.editorial_category
FROM configured
WHERE NOT EXISTS (
  SELECT 1 FROM public.media_partners AS partner
  WHERE partner.agreement_reference='operator-confirmed:2026-10-09:'||configured.source_key
);

WITH configured(source_key) AS (
  VALUES ('zero1net'),('numerama'),('le-monde-pixels'),('gamekult'),('jeuxvideo-com'),
    ('franceinfo-cinema'),('livres-hebdo'),('franceinfo-livres'),('voyageurs-du-net'),
    ('routard'),('reporterre'),('natura-sciences'),('consoglobe'),
    ('le-monde-culture'),('beaux-arts'),('grazia')
)
INSERT INTO public.partner_rss_sources(partner_id,source_key,enabled,auto_publish,next_fetch_at)
SELECT partner.id,configured.source_key,true,true,to_timestamp(0)
FROM configured
JOIN public.media_partners AS partner
  ON partner.agreement_reference='operator-confirmed:2026-10-09:'||configured.source_key
ON CONFLICT(partner_id,source_key) DO UPDATE SET
  enabled=true,
  auto_publish=true,
  etag=NULL,
  last_modified=NULL,
  next_fetch_at=to_timestamp(0),
  lease_token=NULL,
  lease_until=NULL;

-- Fetch the new sources now; the hourly drain remains the fallback.
SELECT private.partner_rss_daily_tick();

COMMIT;