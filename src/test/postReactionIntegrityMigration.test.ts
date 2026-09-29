import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260930120200_enforce_single_post_reaction.sql',
  ),
  'utf8',
).toLowerCase();

describe('post reaction database integrity migration', () => {
  it('enforces one reaction row per user and post', () => {
    expect(migration).toContain('unique (user_id, post_id)');
    expect(migration).toContain('likes_duplicate_user_post');
    expect(migration).toContain('drop constraint if exists likes_user_post_unique');
  });

  it('allows only the owner to replace a reaction through RLS', () => {
    expect(migration).toContain('for update');
    expect(migration).toContain('to authenticated');
    expect(migration).toContain('using ((select auth.uid()) = user_id)');
    expect(migration).toContain('with check ((select auth.uid()) = user_id)');
  });

  it('prevents an update from moving a reaction to another identity', () => {
    expect(migration).toContain('new.user_id is distinct from old.user_id');
    expect(migration).toContain('new.post_id is distinct from old.post_id');
    expect(migration).toContain('post_reaction_identity_immutable');
  });
});
