import { describe, expect, it } from 'vitest';
import {
  buildFeedPage,
  createInitialFeedCursor,
  prependFeedPageItem,
  readRankedFeedPage,
  replaceFeedPageItems,
} from '../feedPagination';

describe('server cursor feed pagination', () => {
  it('starts without a client-computed offset', () => {
    expect(createInitialFeedCursor()).toBeNull();
  });

  it('carries the opaque server cursor without deriving ranking state', () => {
    const page = buildFeedPage(
      [{ id: 'p1' }, { id: 'p2' }],
      { nextCursor: '1f9a3d73-05da-4fc5-8078-aee4c90a38e2', hasMore: true },
    );

    expect(page.map((post) => post.id)).toEqual(['p1', 'p2']);
    expect(page.nextCursor).toBe('1f9a3d73-05da-4fc5-8078-aee4c90a38e2');
    expect(page.sourceCount).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it('does not request another page unless the server supplies a cursor', () => {
    const page = buildFeedPage([{ id: 'p1' }], { hasMore: true });

    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  it('validates and maps the JSON page returned by the RPC', () => {
    const page = readRankedFeedPage(
      {
        items: [{ id: 'p1', user_id: 'u1' }],
        next_cursor: null,
        has_more: false,
      },
      (post) => ({ id: String(post.id), userId: String(post.user_id) }),
    );

    expect(page.map((post) => post)).toEqual([{ id: 'p1', userId: 'u1' }]);
    expect(page.sourceCount).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it('rejects malformed payloads instead of silently changing pagination', () => {
    expect(() => readRankedFeedPage({ items: null }, (post) => post)).toThrow(
      'INVALID_RANKED_FEED_ITEMS',
    );
  });

  it('preserves the server cursor across optimistic cache updates', () => {
    const original = buildFeedPage(
      [{ id: 'p1' }, { id: 'p2' }],
      { nextCursor: 'f60bb6aa-bbb9-41c9-8374-bd2db75079a1', hasMore: true },
    );
    const prepended = prependFeedPageItem(original, { id: 'p0' });
    const filtered = replaceFeedPageItems(
      prepended,
      prepended.filter((post) => post.id !== 'p1'),
    );

    expect(filtered.map((post) => post.id)).toEqual(['p0', 'p2']);
    expect(filtered.nextCursor).toBe('f60bb6aa-bbb9-41c9-8374-bd2db75079a1');
    expect(filtered.hasMore).toBe(true);
  });
});
