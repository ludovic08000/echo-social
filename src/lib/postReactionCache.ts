import { replaceFeedPageItems, type FeedPage } from '@/lib/feedPagination';

export interface ReactionCachePost {
  id: string;
  user_reaction?: string | null;
  is_liked?: boolean;
  likes_count?: number;
  [key: string]: unknown;
}

type PostUpdater = (post: ReactionCachePost) => ReactionCachePost;

function isReactionCachePost(value: unknown): value is ReactionCachePost {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { id?: unknown }).id === 'string';
}

function updatePostArray(
  posts: unknown[],
  postId: string,
  updater: PostUpdater,
): unknown[] {
  return posts.map((post) => (
    isReactionCachePost(post) && post.id === postId ? updater(post) : post
  ));
}

/**
 * Updates all React Query shapes used by posts while preserving the opaque
 * cursor metadata attached to infinite-feed pages.
 */
export function updatePostInReactionCache<T>(
  old: T,
  postId: string,
  updater: PostUpdater,
): T {
  if (!old) return old;

  if (Array.isArray(old)) {
    return updatePostArray(old, postId, updater) as T;
  }

  if (typeof old !== 'object') return old;

  const record = old as Record<string, unknown>;
  if (Array.isArray(record.pages)) {
    const pages = record.pages.map((page) => {
      if (!Array.isArray(page)) return page;

      const updatedItems = updatePostArray(page, postId, updater) as ReactionCachePost[];
      return replaceFeedPageItems(
        page as FeedPage<ReactionCachePost>,
        updatedItems,
      );
    });

    return { ...record, pages } as T;
  }

  if (isReactionCachePost(old) && old.id === postId) {
    return updater(old) as T;
  }

  return old;
}

export function applyPostReaction(
  post: ReactionCachePost,
  reactionType: string,
  hadReactionHint = false,
): ReactionCachePost {
  const hadReaction = hadReactionHint
    || Boolean(post.user_reaction)
    || post.is_liked === true;
  const currentCount = typeof post.likes_count === 'number' ? post.likes_count : 0;

  return {
    ...post,
    user_reaction: reactionType,
    is_liked: true,
    likes_count: hadReaction ? currentCount : currentCount + 1,
  };
}

export function removePostReaction(post: ReactionCachePost): ReactionCachePost {
  const currentCount = typeof post.likes_count === 'number' ? post.likes_count : 0;

  return {
    ...post,
    user_reaction: null,
    is_liked: false,
    likes_count: Math.max(0, currentCount - 1),
  };
}
