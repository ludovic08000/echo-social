import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('post publication feed cache contract', () => {
  const source = readFileSync('src/hooks/usePosts.ts', 'utf8');

  it('keeps a successful author post visible instead of refetching over it', () => {
    const createPostSource = source.slice(
      source.indexOf('export function useCreatePost()'),
      source.indexOf('export function useDeletePost()'),
    );

    expect(createPostSource).toContain("const authorFeedKey = ['posts', 'friends-feed', user?.id]");
    expect(createPostSource).toMatch(/queryClient\.setQueryData<any>\(\s*authorFeedKey,/);
    expect(createPostSource).toContain("refetchType: 'none'");
    expect(createPostSource).not.toContain("queryClient.invalidateQueries({ queryKey: ['posts'] });");
  });

  it('still refreshes the author profile post list', () => {
    expect(source).toContain("queryClient.invalidateQueries({ queryKey: ['posts', 'user', user.id] })");
  });
});
