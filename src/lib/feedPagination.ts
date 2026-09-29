export type FeedCursor = string | null;

export type FeedPage<T> = T[] & {
  nextCursor: FeedCursor;
  hasMore: boolean;
  sourceCount: number;
};

export interface RankedFeedPagePayload {
  items?: unknown;
  next_cursor?: unknown;
  has_more?: unknown;
  snapshot_expires_at?: unknown;
}

interface BuildFeedPageOptions {
  nextCursor?: unknown;
  hasMore?: unknown;
}

export function createInitialFeedCursor(): FeedCursor {
  return null;
}

/**
 * Adapts the server-owned snapshot page to React Query's array page shape.
 * The cursor stays opaque: the browser neither calculates an offset nor
 * carries post IDs, ranking state or author-diversity state between pages.
 */
export function buildFeedPage<T>(
  sourceItems: T[],
  options: BuildFeedPageOptions = {},
): FeedPage<T> {
  const nextCursor = typeof options.nextCursor === 'string' && options.nextCursor.length > 0
    ? options.nextCursor
    : null;
  const hasMore = options.hasMore === true && nextCursor !== null;

  return Object.assign([...sourceItems], {
    nextCursor,
    hasMore,
    sourceCount: sourceItems.length,
  });
}

export function replaceFeedPageItems<T>(
  page: FeedPage<T>,
  items: T[],
): FeedPage<T> {
  return buildFeedPage(items, {
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
}

export function prependFeedPageItem<T>(
  page: FeedPage<T>,
  item: T,
): FeedPage<T> {
  return replaceFeedPageItems(page, [item, ...page]);
}

export function readRankedFeedPage<T>(
  payload: unknown,
  mapItem: (item: Record<string, unknown>) => T,
): FeedPage<T> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('INVALID_RANKED_FEED_PAGE');
  }

  const page = payload as RankedFeedPagePayload;
  if (!Array.isArray(page.items)) {
    throw new Error('INVALID_RANKED_FEED_ITEMS');
  }

  const mappedItems = page.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('INVALID_RANKED_FEED_ITEM');
    }
    return mapItem(item as Record<string, unknown>);
  });

  return buildFeedPage(mappedItems, {
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
  });
}
