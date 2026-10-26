import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20261026222000_pin_recent_own_post_in_feed.sql';
const sql = readFileSync(migrationPath, 'utf8')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

describe('recent author publication priority', () => {
  it('pins only the viewer newest recent publication before diversity reranking', () => {
    expect(sql).toContain('own_post.user_id = new.viewer_id');
    expect(sql).toContain("own_post.created_at >= now() - interval '15 minutes'");
    expect(sql).toContain('order by own_post.created_at desc, entry.ordinality');
    expect(sql).toContain("to_jsonb('own_recent'::text)");
    expect(sql.indexOf("to_jsonb('own_recent'::text)")).toBeLessThan(
      sql.indexOf('while jsonb_array_length(remaining) > 0 loop'),
    );
  });

  it('does not modify retrieval, model weights, experiments, or other viewers', () => {
    expect(sql).not.toContain('create or replace function public.ml_retrieve_feed_candidates_v8');
    expect(sql).not.toContain('create or replace function public.get_feed_posts_v8');
    expect(sql).not.toContain('update public.ml_feed_experiments');
    expect(sql).not.toContain('insert into public.ml_feed_experiments');
    expect(sql).not.toContain('retrieval_weight');
    expect(sql).not.toContain('exploration_weight');
    expect(sql).toContain("if coalesce(feed_mode, 'smart') <> 'smart' then return new;");
  });

  it('keeps serving-time eligibility checks authoritative', () => {
    expect(sql).toContain('will still be rechecked by feed_eligible_post_ids_internal when served');
    expect(sql).toContain('own_post.publish_at is null or own_post.publish_at <= now()');
    expect(sql).toContain('own_post.expires_at is null or own_post.expires_at > now()');
  });
});
