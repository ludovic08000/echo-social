import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260929155548_repair_feed_telemetry_coverage_mmr.sql';
const candidateFixPath =
  'supabase/migrations/20260929213042_qualify_blocked_post_reference.sql';

const rawSql = readFileSync(migrationPath, 'utf8');
const sql = rawSql.toLowerCase().replace(/\s+/g, ' ').trim();
const candidateFixSql = readFileSync(candidateFixPath, 'utf8')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();
const trainerSource = readFileSync('supabase/functions/ml-feed-train/index.ts', 'utf8');

describe('feed reliability migration', () => {
  it('repairs A/B ordinality and rejects invalid post references per row', () => {
    expect(sql).toContain('with ordinality as events(e, ord)');
    expect(sql).toContain('join public.posts post on post.id = clean.post_id');
    expect(sql).toContain(
      'grant execute on function public.ml_record_feed_ab_events(jsonb) to authenticated, service_role;',
    );
  });

  it('does not alter the active experiment or any ranking weight', () => {
    expect(sql).not.toContain('update public.ml_feed_experiments');
    expect(sql).not.toContain('insert into public.ml_feed_experiments');
    expect(sql).not.toContain('retrieval_weight');
    expect(sql).not.toContain('exploration_weight');
    expect(sql).not.toContain('new_creator_boost');
    expect(sql).not.toContain('diversity_author_cap');
  });

  it('stores private coverage metrics and gates multi-objective readiness', () => {
    expect(sql).toContain('create table if not exists public.ml_feed_coverage_snapshots');
    expect(sql).toContain('alter table public.ml_feed_coverage_snapshots enable row level security');
    expect(sql).toContain('v_total_posts >= 500');
    expect(sql).toContain('v_ab_7d >= 10000');
    expect(sql).toContain('multi_objective_ready');
  });

  it('keeps MMR shadow-only and installs one Vault-backed trainer schedule', () => {
    expect(sql).toContain('create table if not exists public.ml_feed_mmr_shadow_runs');
    expect(sql).toContain('create or replace function public.ml_feed_train_cron_tick()');
    expect(sql).toContain("where secret.name = 'email_queue_service_role_key'");
    expect(sql).toContain("'forsure-ml-feed-train-hourly'");
    expect(sql).toContain('select public.ml_backfill_feed_feature_shells();');
  });

  it('carries embedding text from the async extraction batch into persistence', () => {
    expect(trainerSource).toContain('generateEmbeddingBatch(embeddingTexts)');
    expect(trainerSource).toContain('for (const { post, f, emb, embText } of results)');
    expect(trainerSource).toContain('const current = existingMap.get(post.id);');
  });

  it('uses a bounded, batched Lovable embedding request with the stored dimension', () => {
    expect(trainerSource).toContain('const EMBEDDING_MODEL = "google/gemini-embedding-2";');
    expect(trainerSource).toContain('const EMBEDDING_DIMENSION = 768;');
    expect(trainerSource).toContain('input: active.map(({ text }) => text)');
    expect(trainerSource).toContain('dimensions: EMBEDDING_DIMENSION');
    expect(trainerSource).toContain('signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)');
    expect(trainerSource).toContain('skipped: "RUN_ALREADY_ACTIVE"');
  });

  it('qualifies every blocked-post reference without changing ranking or A/B weights', () => {
    expect(candidateFixSql).not.toContain('select post_id from blocked');
    expect(
      candidateFixSql.match(
        /select blocked_post\.post_id from blocked as blocked_post/g,
      ),
    ).toHaveLength(6);
    expect(candidateFixSql).not.toContain('update public.ml_feed_experiments');
    expect(candidateFixSql).not.toContain('insert into public.ml_feed_experiments');
    expect(candidateFixSql).not.toContain('retrieval_weight');
    expect(candidateFixSql).not.toContain('exploration_weight');
    expect(candidateFixSql).not.toContain('new_creator_boost');
    expect(candidateFixSql).not.toContain('diversity_author_cap');
  });

});
