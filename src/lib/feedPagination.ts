import { enforceDiversity } from '@/lib/feedDiversity';

export interface FeedCursor {
  offset: number;
  seenPostIds: string[];
  tailAuthorIds: string[];
}

export type FeedPage<T> = T[] & {
  nextCursor: FeedCursor;
  hasMore: boolean;
  sourceCount: number;
};

interface FeedPageItem {
  id: string;
  user_id: string;
}

interface BuildFeedPageOptions<T> {
  fetchSize: number;
  pageSize?: number;
  include?: (item: T) => boolean;
  maxConsecutiveSameAuthor?: number;
  maxRememberedPostIds?: number;
}

export function createInitialFeedCursor(): FeedCursor {
  return { offset: 0, seenPostIds: [], tailAuthorIds: [] };
}

/**
 * Turns one server batch into an array page while carrying source progress,
 * deduplication state and the preceding author tail to the next page. Advancing
 * by sourceCount (not the number left after filters) prevents offset overlap.
 */
export function buildFeedPage<T extends FeedPageItem>(
  sourceItems: T[],
  cursor: FeedCursor,
  options: BuildFeedPageOptions<T>,
): FeedPage<T> {
  const {
    fetchSize,
    pageSize = fetchSize,
    include = () => true,
    maxConsecutiveSameAuthor = 2,
    maxRememberedPostIds = 500,
  } = options;
  const knownIds = new Set(cursor.seenPostIds);
  const pageBatchIds: string[] = [];
  const candidates: T[] = [];

  for (const item of sourceItems) {
    if (!item?.id || knownIds.has(item.id)) continue;
    knownIds.add(item.id);
    pageBatchIds.push(item.id);
    if (include(item)) candidates.push(item);
  }

  const diversified = enforceDiversity(
    candidates,
    maxConsecutiveSameAuthor,
    cursor.tailAuthorIds,
  ).slice(0, pageSize);
  const rememberedIds = [...cursor.seenPostIds, ...pageBatchIds].slice(-maxRememberedPostIds);
  const tailAuthorIds = [...cursor.tailAuthorIds, ...diversified.map((item) => item.user_id)]
    .slice(-maxConsecutiveSameAuthor);

  return Object.assign(diversified, {
    nextCursor: {
      offset: cursor.offset + sourceItems.length,
      seenPostIds: rememberedIds,
      tailAuthorIds,
    },
    hasMore: sourceItems.length >= fetchSize,
    sourceCount: sourceItems.length,
  });
}
