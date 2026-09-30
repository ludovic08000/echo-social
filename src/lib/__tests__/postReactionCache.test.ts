import { describe, expect, it } from 'vitest';
import { buildFeedPage } from '@/lib/feedPagination';
import {
  applyPostReaction,
  updatePostInReactionCache,
} from '@/lib/postReactionCache';

describe('post reaction cache integrity', () => {
  it('increments the count only for the first reaction', () => {
    const first = applyPostReaction({ id: 'post-1', likes_count: 4 }, 'love');
    const replacement = applyPostReaction(first, 'wow', true);

    expect(first).toMatchObject({
      user_reaction: 'love',
      is_liked: true,
      likes_count: 5,
    });
    expect(replacement).toMatchObject({
      user_reaction: 'wow',
      is_liked: true,
      likes_count: 5,
    });
  });

  it('uses the local previous-reaction hint when a stale page says null', () => {
    const replacement = applyPostReaction(
      { id: 'post-1', user_reaction: null, likes_count: 5 },
      'sad',
      true,
    );

    expect(replacement.likes_count).toBe(5);
  });

  it('preserves the opaque feed cursor during an optimistic replacement', () => {
    const page = buildFeedPage(
      [{ id: 'post-1', user_reaction: 'like', likes_count: 7 }],
      { nextCursor: 'opaque-next-page', hasMore: true },
    );
    const cache = { pages: [page], pageParams: [null] };

    const updated = updatePostInReactionCache(
      cache,
      'post-1',
      (post) => applyPostReaction(post, 'angry', true),
    );

    expect(updated.pages[0][0]).toMatchObject({
      user_reaction: 'angry',
      likes_count: 7,
    });
    expect(updated.pages[0].nextCursor).toBe('opaque-next-page');
    expect(updated.pages[0].hasMore).toBe(true);
  });
});
