// Executes the real positive-editorial migration in isolated PostgreSQL WASM.
// No Lovable Cloud connection, production data or publisher network is used.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const baseMigration = readFileSync(
  new URL('../supabase/migrations/20261008170000_positive_editorial_media.sql', import.meta.url),
  'utf8',
);
const freshnessMigration = readFileSync(
  new URL('../supabase/migrations/20261008204946_fresh_daily_sport_media.sql', import.meta.url),
  'utf8',
);
const mlCompatibilityMigration = readFileSync(
  new URL('../supabase/migrations/20261008210755_align_editorial_media_with_user_ml.sql', import.meta.url),
  'utf8',
);
const viewer = '00000000-0000-4000-8000-000000000001';
const db = new PGlite();

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE SCHEMA private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION private.partner_rss_daily_tick() RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    CREATE FUNCTION public.media_place_key(value text) RETURNS text LANGUAGE sql IMMUTABLE AS
      $$ SELECT lower(regexp_replace(coalesce(value,''),'[^a-z0-9]+','','g')) $$;
    CREATE TABLE public.user_feed_preferences(
      user_id uuid PRIMARY KEY,
      feed_algorithm text NOT NULL DEFAULT 'smart',
      diversity_boost integer NOT NULL DEFAULT 50,
      muted_keywords text[] NOT NULL DEFAULT ARRAY[]::text[],
      priority_topics text[] NOT NULL DEFAULT ARRAY[]::text[],
      viral_content_reduce boolean NOT NULL DEFAULT false,
      sensitive_content_filter boolean NOT NULL DEFAULT true,
      seen_posts_hide boolean NOT NULL DEFAULT false,
      weight_friends integer NOT NULL DEFAULT 60,
      weight_discovery integer NOT NULL DEFAULT 30,
      weight_marketplace integer NOT NULL DEFAULT 10,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.user_interests(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      interest_type text NOT NULL,
      interest_value text NOT NULL,
      weight numeric NOT NULL DEFAULT 1,
      explicit boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(user_id,interest_type,interest_value)
    );
    CREATE TABLE public.media_partners(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      website_host text NOT NULL,
      country text NOT NULL DEFAULT 'FR',
      region text,
      city text,
      agreement_reference text NOT NULL,
      rights_until timestamptz NOT NULL,
      allow_excerpt boolean NOT NULL DEFAULT false,
      allow_youtube_embed boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.partner_rss_sources(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id uuid NOT NULL REFERENCES public.media_partners(id),
      source_key text NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      auto_publish boolean NOT NULL DEFAULT false,
      etag text,
      last_modified text,
      next_fetch_at timestamptz NOT NULL DEFAULT now(),
      lease_token uuid,
      lease_until timestamptz,
      UNIQUE(partner_id,source_key)
    );
    CREATE TABLE public.partner_media_items(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id uuid NOT NULL REFERENCES public.media_partners(id),
      discussion_id uuid,
      title text NOT NULL,
      excerpt text NOT NULL DEFAULT '',
      canonical_url text NOT NULL,
      kind text NOT NULL,
      youtube_id text,
      thumbnail_url text,
      published_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      moderated boolean NOT NULL DEFAULT false
    );
  `);
  await db.exec(baseMigration);
  await db.exec(freshnessMigration);
  await db.exec(mlCompatibilityMigration);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [viewer]);
  await db.query(
    'INSERT INTO public.user_feed_preferences(user_id,priority_topics,weight_news) VALUES($1,$2,100)',
    [viewer, ['science']],
  );
  await db.query(
    `INSERT INTO public.user_interests(user_id,interest_type,interest_value,weight,explicit)
     VALUES($1,'category','wellbeing',2,true)`,
    [viewer],
  );
  await db.exec(`
    INSERT INTO public.media_partners(
      name,website_host,country,region,agreement_reference,rights_until,active,editorial_category
    ) VALUES (
      'Actualité locale','local.invalid','FR','Grand Est','fixture-local',now()+interval '1 year',true,'general'
    );
    WITH chosen AS (
      SELECT DISTINCT ON (editorial_category) id,editorial_category,website_host
      FROM public.media_partners
      WHERE editorial_category<>'general'
      ORDER BY editorial_category,name
    ), all_lanes AS (
      SELECT id,editorial_category,website_host FROM chosen
      UNION ALL
      SELECT id,editorial_category,website_host
      FROM public.media_partners WHERE agreement_reference='fixture-local'
    )
    INSERT INTO public.partner_media_items(
      partner_id,title,canonical_url,kind,published_at,expires_at,moderated
    )
    SELECT id,'Titre '||editorial_category,'https://'||website_host||'/article-'||editorial_category,
      'article',now()-interval '1 hour',now()+interval '1 day',true
    FROM all_lanes;
    INSERT INTO public.partner_media_items(
      partner_id,title,canonical_url,kind,published_at,expires_at,moderated
    )
    SELECT id,'Ancienne actualité masquée','https://www.lemonde.fr/ancienne-actualite-test',
      'article',now()-interval '2 days',now()+interval '5 days',true
    FROM public.media_partners
    WHERE agreement_reference='operator-confirmed:2026-10-08:le-monde-sciences';
  `);

  const categories = await db.query(`
    SELECT editorial_category,count(*)::integer AS count
    FROM public.media_partners
    WHERE agreement_reference LIKE 'operator-confirmed:2026-10-08:%'
    GROUP BY editorial_category
    ORDER BY editorial_category
  `);
  assert.deepEqual(categories.rows, [
    { editorial_category: 'education', count: 3 },
    { editorial_category: 'music', count: 3 },
    { editorial_category: 'science', count: 4 },
    { editorial_category: 'sport', count: 3 },
    { editorial_category: 'wellbeing', count: 3 },
  ]);
  const sources = await db.query(
    `SELECT count(*)::integer AS count,
      bool_and(next_fetch_at < now()-interval '1 year') AS prioritized
     FROM public.partner_rss_sources WHERE enabled AND auto_publish`,
  );
  assert.equal(sources.rows[0].count, 16);
  assert.equal(sources.rows[0].prioritized, true);

  const result = await db.query(
    "SELECT public.partner_media_for_zone('nearby','all','FR','Grand Est',NULL) AS items",
  );
  const items = result.rows[0].items;
  assert.equal(items[0].editorial_category, 'science');
  assert.equal(items[0].rank_reason, 'declared_interest');
  assert.equal(items.find(item => item.editorial_category === 'wellbeing')?.rank_reason, 'declared_interest');
  assert.deepEqual(
    new Set(items.slice(0, 6).map(item => item.editorial_category)),
    new Set(['general', 'science', 'music', 'education', 'wellbeing', 'sport']),
  );
  assert.equal(items.some(item => item.title === 'Ancienne actualité masquée'), false);
  const topicMatch = await db.query(`
    SELECT
      public.feed_priority_topic_matches(ARRAY['education'],ARRAY['éducation'],ARRAY[]::text[],'') AS education,
      public.feed_priority_topic_matches(ARRAY['wellbeing'],ARRAY[]::text[],ARRAY[]::text[],'psychologie positive') AS wellbeing
  `);
  assert.deepEqual(topicMatch.rows[0], { education: true, wellbeing: true });

  await db.query('UPDATE public.user_feed_preferences SET weight_news=0 WHERE user_id=$1', [viewer]);
  const disabled = await db.query(
    "SELECT public.partner_media_for_zone('nearby','all','FR','Grand Est',NULL) AS items",
  );
  assert.deepEqual(disabled.rows[0].items, []);
  await db.query('UPDATE public.user_feed_preferences SET weight_news=999 WHERE user_id=$1', [viewer]);
  const clamped = await db.query('SELECT weight_news FROM public.user_feed_preferences WHERE user_id=$1', [viewer]);
  assert.equal(clamped.rows[0].weight_news, 100);
  const retained = await db.query(
    "SELECT count(*)::integer AS count FROM public.partner_media_items WHERE title='Ancienne actualité masquée'",
  );
  assert.equal(retained.rows[0].count, 1);
  console.log('Positive editorial media SQL: user-controlled ML blend + 16 sources + six balanced lanes + 36-hour freshness passed.');
} catch (error) {
  console.error(error.message, error.detail ?? '', error.where ?? '');
  process.exitCode = 1;
} finally {
  await db.close();
}
