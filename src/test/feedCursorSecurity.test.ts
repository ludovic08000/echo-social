import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260929235900_secure_feed_visibility_and_cursor.sql';
const rawSql = readFileSync(migrationPath, 'utf8');
const sql = rawSql.toLowerCase().replace(/\s+/g, ' ').trim();
const postsHook = readFileSync('src/hooks/usePosts.ts', 'utf8');
const usePostsSource = postsHook.slice(
  postsHook.indexOf('export function usePosts()'),
  postsHook.indexOf('export function useUserPosts'),
);

describe('feed visibility and stable cursor boundary', () => {
  it('binds personalized compatibility requests to the authenticated JWT', () => {
    expect(sql).toContain('v_authenticated_user uuid := (select auth.uid())');
    expect(sql).toContain('p_user_id <> v_authenticated_user');
    expect(sql).toContain("v_claim_role = 'service_role'");
    expect(sql).toContain('v_user_id := null');
  });

  it('enforces post privacy, blocks and negative feedback before ranking', () => {
    expect(sql).toContain("coalesce(privacy.posts_visibility, 'public') = 'friends'");
    expect(sql).toContain('from public.user_message_blocks as user_block');
    expect(sql).toContain("exclusion.signal_type in ('hide', 'not_interested', 'report')");
    expect(sql).toContain('coalesce(preference.muted_keywords, array[]::text[])');
    expect(sql).toContain('coalesce(preference.sensitive_content_filter, true)');
    expect(sql).toContain('public.feed_eligible_post_ids_internal( v_user_id, array(');
    expect(sql).toContain('join eligible as eligible_post on eligible_post.post_id = candidate.post_id');
  });

  it('keeps snapshots private and rechecks eligibility when each page is read', () => {
    expect(sql).toContain('alter table public.feed_rank_snapshots enable row level security');
    expect(sql).toContain('alter table public.feed_rank_cursors enable row level security');
    expect(sql).toContain(
      'revoke all on table public.feed_rank_snapshots from public, anon, authenticated, service_role',
    );
    expect(sql).toContain('cursor_row.viewer_id is not distinct from v_viewer_id');
    expect(sql).toContain('snapshot.viewer_id is not distinct from v_viewer_id');
    expect(sql).toContain('public.feed_eligible_post_ids_internal( v_viewer_id, array(');
    expect(sql).toContain('join eligible as eligible_post on eligible_post.post_id = post.id');
  });

  it('exposes only an opaque cursor API to the browser feed', () => {
    const pageSignature = sql.match(
      /create or replace function public\.get_ranked_feed_page\((.*?)\) returns jsonb/,
    );

    expect(pageSignature?.[1]).toContain('p_cursor uuid');
    expect(pageSignature?.[1]).not.toContain('p_user_id');
    expect(usePostsSource).toContain("supabase.rpc('get_ranked_feed_page'");
    expect(usePostsSource).not.toContain('get_feed_posts_v8');
    expect(usePostsSource).not.toContain("supabase.rpc('get_feed_posts'");
    expect(usePostsSource).not.toContain(".from('posts')");
    expect(usePostsSource).not.toContain('feed_score_batch');
  });

  it('removes direct browser access to arbitrary-user ranking helpers', () => {
    expect(sql).toContain(
      'revoke all on function public.ml_retrieve_feed_candidates_v8(uuid, integer) from public, anon, authenticated',
    );
    expect(sql).toContain(
      'revoke all on function public.feed_score_batch(uuid, uuid[], text) from public, anon, authenticated',
    );
    expect(sql).toContain(
      'grant execute on function public.feed_score_batch(uuid, uuid[], text) to service_role',
    );
  });

  it('does not update experiments or ranking configuration', () => {
    expect(sql).not.toContain('update public.ml_feed_experiments');
    expect(sql).not.toContain('insert into public.ml_feed_experiments');
    expect(sql).not.toContain('update public.ml_model_config');
    expect(sql).not.toContain('insert into public.ml_model_config');
  });
});
