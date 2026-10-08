// Executes the real positive-editorial migration in isolated PostgreSQL WASM.
// No Lovable Cloud connection, production data or publisher network is used.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const migration = readFileSync(
  new URL('../supabase/migrations/20261008170000_positive_editorial_media.sql', import.meta.url),
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
      priority_topics text[] NOT NULL DEFAULT ARRAY[]::text[]
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
  await db.exec(migration);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [viewer]);
  await db.query(
    'INSERT INTO public.user_feed_preferences(user_id,priority_topics) VALUES($1,$2)',
    [viewer, ['science']],
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
    { editorial_category: 'wellbeing', count: 3 },
  ]);
  const sources = await db.query(
    `SELECT count(*)::integer AS count,
      bool_and(next_fetch_at < now()-interval '1 year') AS prioritized
     FROM public.partner_rss_sources WHERE enabled AND auto_publish`,
  );
  assert.equal(sources.rows[0].count, 13);
  assert.equal(sources.rows[0].prioritized, true);

  const result = await db.query(
    "SELECT public.partner_media_for_zone('nearby','all','FR','Grand Est',NULL) AS items",
  );
  const items = result.rows[0].items;
  assert.equal(items[0].editorial_category, 'science');
  assert.deepEqual(
    new Set(items.slice(0, 5).map(item => item.editorial_category)),
    new Set(['general', 'science', 'music', 'education', 'wellbeing']),
  );
  console.log('Positive editorial media SQL: migration + 13 sources + balanced first page passed.');
} catch (error) {
  console.error(error.message, error.detail ?? '', error.where ?? '');
  process.exitCode = 1;
} finally {
  await db.close();
}
