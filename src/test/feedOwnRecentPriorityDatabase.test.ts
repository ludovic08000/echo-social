// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261026222000_pin_recent_own_post_in_feed.sql',
  'utf8',
).replace(/^BEGIN;|COMMIT;$/gm, '');

const viewerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const ownPostId = '33333333-3333-4333-8333-333333333333';
const otherPostId = '44444444-4444-4444-8444-444444444444';

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create table public.ml_feed_experiments (
      key text primary key,
      variant_a jsonb not null,
      variant_b jsonb not null,
      traffic_split numeric not null,
      updated_at timestamptz not null default now()
    );
    create table public.user_feed_preferences (
      user_id uuid primary key,
      feed_algorithm text
    );
    create table public.posts (
      id uuid primary key,
      user_id uuid not null,
      created_at timestamptz not null,
      publish_at timestamptz,
      expires_at timestamptz
    );
    create table public.feed_rank_snapshots (
      id uuid primary key default gen_random_uuid(),
      viewer_id uuid,
      items jsonb not null,
      experiment_revision text
    );
    create function public.ml_recsys_v8_assignment(uuid, text)
    returns table (diversity_author_cap integer)
    language sql stable
    as $$ select 2 $$;
    insert into public.ml_feed_experiments (key, variant_a, variant_b, traffic_split)
    values ('recsys_v8_main', '{}'::jsonb, '{}'::jsonb, 0.5);
  `);
  await db.exec(migration);
  await db.exec(`
    create trigger z_finalize_feed_snapshot
    before insert on public.feed_rank_snapshots
    for each row execute function public.finalize_feed_snapshot();
  `);
  return db;
}

describe('recent author priority database behavior', () => {
  it('moves only the viewer newest recent post to the first snapshot position', async () => {
    const db = await createDatabase();
    try {
      await db.query(
        `insert into public.posts (id, user_id, created_at)
         values ($1, $2, now() - interval '1 minute'),
                ($3, $4, now() - interval '2 minutes')`,
        [ownPostId, viewerId, otherPostId, otherId],
      );
      await db.query(
        `insert into public.feed_rank_snapshots (viewer_id, items)
         values ($1, $2::jsonb)`,
        [
          viewerId,
          JSON.stringify([
            { id: otherPostId, user_id: otherId, rank_reason: 'recsys_v8' },
            { id: ownPostId, user_id: viewerId, rank_reason: 'recsys_v8' },
          ]),
        ],
      );

      const result = await db.query<{ items: Array<{ id: string; rank_reason: string }> }>(
        'select items from public.feed_rank_snapshots where viewer_id = $1',
        [viewerId],
      );
      expect(result.rows[0].items.map((item) => item.id)).toEqual([ownPostId, otherPostId]);
      expect(result.rows[0].items[0].rank_reason).toBe('own_recent');
    } finally {
      await db.close();
    }
  });

  it('preserves smart ranking for a viewer who did not author a recent candidate', async () => {
    const db = await createDatabase();
    try {
      await db.query(
        `insert into public.posts (id, user_id, created_at)
         values ($1, $2, now() - interval '1 minute'),
                ($3, $2, now() - interval '2 minutes')`,
        [ownPostId, otherId, otherPostId],
      );
      await db.query(
        `insert into public.feed_rank_snapshots (viewer_id, items)
         values ($1, $2::jsonb)`,
        [
          viewerId,
          JSON.stringify([
            { id: otherPostId, user_id: otherId, rank_reason: 'first' },
            { id: ownPostId, user_id: otherId, rank_reason: 'second' },
          ]),
        ],
      );

      const result = await db.query<{ items: Array<{ id: string }> }>(
        'select items from public.feed_rank_snapshots where viewer_id = $1',
        [viewerId],
      );
      expect(result.rows[0].items.map((item) => item.id)).toEqual([otherPostId, ownPostId]);
    } finally {
      await db.close();
    }
  });
});
