import { describe, expect, it } from 'vitest';
import { buildFeedPage, createInitialFeedCursor } from '../feedPagination';

const item = (id: string, author: string, body = '') => ({ id, user_id: author, body });

describe('feed pagination reliability', () => {
  it('advances by source rows even when client preferences filter a post', () => {
    const page = buildFeedPage(
      [item('p1', 'a'), item('p2', 'b', 'muted'), item('p3', 'c')],
      createInitialFeedCursor(),
      { fetchSize: 3, include: (post) => post.body !== 'muted' },
    );

    expect(page.map((post) => post.id)).toEqual(['p1', 'p3']);
    expect(page.nextCursor.offset).toBe(3);
    expect(page.sourceCount).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it('deduplicates a post repeated by a moving server ranking', () => {
    const page = buildFeedPage(
      [item('p1', 'a'), item('p4', 'd')],
      { offset: 3, seenPostIds: ['p1', 'p2', 'p3'], tailAuthorIds: ['b', 'c'] },
      { fetchSize: 2 },
    );

    expect(page.map((post) => post.id)).toEqual(['p4']);
    expect(page.nextCursor.offset).toBe(5);
    expect(page.nextCursor.seenPostIds).toContain('p4');
  });

  it('carries author diversity across the page boundary', () => {
    const page = buildFeedPage(
      [item('p3', 'a'), item('p4', 'b'), item('p5', 'a')],
      { offset: 2, seenPostIds: ['p1', 'p2'], tailAuthorIds: ['a', 'a'] },
      { fetchSize: 3, maxConsecutiveSameAuthor: 2 },
    );

    expect(page.map((post) => post.user_id)).toEqual(['b', 'a', 'a']);
    expect(page.nextCursor.tailAuthorIds).toEqual(['a', 'a']);
  });
});
