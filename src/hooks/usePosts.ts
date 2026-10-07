import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { ReactionType } from '@/hooks/useReactions';
import { syncFeedPrefsFromServer } from '@/lib/feedPreferences';
import { mapFeedRpcRow, type FeedRpcRow } from '@/lib/recsysV8';
import {
  createInitialFeedCursor,
  prependFeedPageItem,
  readRankedFeedPage,
  replaceFeedPageItems,
  type FeedCursor,
  isFeedCursorError,
} from '@/lib/feedPagination';
import { emitFeedPerformanceMetric } from '@/hooks/useFeedPerformance';

// One-shot sync per user. Pages await the same promise so the first request
// cannot race against stale local preferences.
const _syncedPrefsUsers = new Map<string, Promise<void>>();
function ensureFeedPrefsSynced(userId: string): Promise<void> {
  const existing = _syncedPrefsUsers.get(userId);
  if (existing) return existing;
  const sync = syncFeedPrefsFromServer(userId)
    .then(() => undefined)
    .catch((error) => {
      _syncedPrefsUsers.delete(userId);
      throw error;
    });
  _syncedPrefsUsers.set(userId, sync);
  return sync;
}

export interface Post {
  exposure_id?: string | null;
  id: string;
  user_id: string;
  body: string;
  image_url: string | null;
  media_thumbnail_url?: string | null;
  created_at: string;
  expires_at?: string | null;
  profile: {
    name: string;
    avatar_url: string | null;
    mood_emoji?: string | null;
  };
  likes_count: number;
  comments_count: number;
  is_liked: boolean;
  user_reaction?: ReactionType | null;
}

// Keep the first response small enough to paint on mobile immediately. The
// 1200px feed sentinel fetches the next page before the user reaches the end.
const PAGE_SIZE = 12;

type FeedRpcResponse = {
  data?: unknown;
  error?: unknown;
};

function feedClockNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

async function runTimedFeedRpc<T extends FeedRpcResponse>(
  cursor: FeedCursor,
  request: () => PromiseLike<T>,
): Promise<T> {
  const startedAt = feedClockNow();
  try {
    const result = await request();
    const payload = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? result.data as { items?: unknown }
      : null;
    emitFeedPerformanceMetric('rpc_latency', feedClockNow() - startedAt, {
      source: 'get_ranked_feed_page',
      page: cursor === null ? 'initial' : 'next',
      outcome: result.error ? 'error' : 'success',
      row_count: Array.isArray(payload?.items) ? payload.items.length : 0,
      target_max_ms: 350,
    });
    return result;
  } catch (error) {
    emitFeedPerformanceMetric('rpc_latency', feedClockNow() - startedAt, {
      source: 'get_ranked_feed_page',
      page: cursor === null ? 'initial' : 'next',
      outcome: 'exception',
      target_max_ms: 350,
    });
    throw error;
  }
}

export function usePosts() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const [expired, setExpired] = useState(false);
  const queryKey = ['posts', 'friends-feed', loading ? 'loading' : user?.id ?? 'guest'];

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }: { pageParam: FeedCursor }) => {
      const cursor = pageParam;
      const preferencesReady = user
        ? ensureFeedPrefsSynced(user.id).catch(() => undefined)
        : Promise.resolve();
      // The initial snapshot must see any one-time migration of local preferences.
      // Subsequent pages only read the immutable server snapshot.
      if (cursor === null) await preferencesReady;
      const result = await runTimedFeedRpc(cursor, () =>
        supabase.rpc('get_ranked_feed_page', {
          p_limit: PAGE_SIZE,
          p_cursor: cursor,
        }),
      );

      if (result.error) throw result.error;

      return readRankedFeedPage<Post>(result.data, (post) => {
        const mapped = mapFeedRpcRow(post as unknown as FeedRpcRow) as Post;
        return user
          ? mapped
          : { ...mapped, is_liked: false, user_reaction: null };
      });
    },
    getNextPageParam: (lastPage) => (
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined
    ),
    initialPageParam: createInitialFeedCursor(),
    enabled: !loading,
    // Stabilize cache: avoid feed reshuffling on every focus / interval.
    // Realtime + manual pull-to-refresh handle freshness.
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    retry: (attempt, error) => !isFeedCursorError(error) && attempt < 2,
  });
  const expiresAt = query.data?.pages[0]?.snapshotExpiresAt;
  useEffect(() => {
    setExpired(false);
    if (!expiresAt) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(expiresAt) - Date.now() - 1000));
    return () => clearTimeout(timer);
  }, [expiresAt, user?.id]);
  return {
    ...query,
    hasNextPage: !expired && query.hasNextPage,
    snapshotExpired: expired || isFeedCursorError(query.error),
    restartFeed: () => queryClient.resetQueries({ queryKey, exact: true }),
  };
}

export function useUserPosts(userId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['posts', 'user', userId],
    queryFn: async () => {
      const { data: posts, error } = await supabase
        .from('posts')
        .select('id, user_id, body, image_url, media_thumbnail_url, created_at, expires_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const { data: profileData } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url, mood_emoji')
        .eq('user_id', userId)
        .maybeSingle();

      const postIds = posts.map(p => p.id);
      
      const [likesRes, commentsRes, userLikesRes] = await Promise.all([
        supabase.from('likes').select('post_id').in('post_id', postIds),
        supabase.from('comments').select('post_id').in('post_id', postIds),
        user 
          ? supabase.from('likes').select('post_id, reaction_type').eq('user_id', user.id).in('post_id', postIds)
          : Promise.resolve({ data: [] }),
      ]);

      const likesCount: Record<string, number> = {};
      const commentsCount: Record<string, number> = {};
      const userReactions = new Map<string, ReactionType>();

      likesRes.data?.forEach(l => { likesCount[l.post_id] = (likesCount[l.post_id] || 0) + 1; });
      commentsRes.data?.forEach(c => { commentsCount[c.post_id] = (commentsCount[c.post_id] || 0) + 1; });
      userLikesRes.data?.forEach((l: { post_id: string; reaction_type: ReactionType }) => {
        userReactions.set(l.post_id, l.reaction_type);
      });

      return posts.map(post => {
        const userReaction = userReactions.get(post.id);
        return {
          id: post.id,
          user_id: post.user_id,
          body: post.body,
          image_url: post.image_url,
          media_thumbnail_url: post.media_thumbnail_url,
          created_at: post.created_at,
          expires_at: (post as any).expires_at || null,
          profile: {
            name: profileData?.name || 'Unknown',
            avatar_url: profileData?.avatar_url || null,
            mood_emoji: (profileData as any)?.mood_emoji || null,
          },
          likes_count: likesCount[post.id] || 0,
          comments_count: commentsCount[post.id] || 0,
          is_liked: !!userReaction,
          user_reaction: userReaction || null,
        };
      });
    },
    enabled: !!userId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}

export function useCreatePost() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      body,
      imageUrl,
      mediaThumbnailUrl,
      expiresAt,
      publishAt,
    }: {
      body: string;
      imageUrl?: string;
      mediaThumbnailUrl?: string;
      expiresAt?: string;
      publishAt?: string;
    }) => {
      if (!user) throw new Error('Not authenticated');

      // Sanitize: strip HTML tags and limit length
      const sanitizedBody = body.replace(/<[^>]*>/g, '').slice(0, 5000);

      const insertData: any = {
        user_id: user.id,
        body: sanitizedBody,
        image_url: imageUrl || null,
        media_thumbnail_url: mediaThumbnailUrl || null,
      };
      if (expiresAt) insertData.expires_at = expiresAt;
      if (publishAt) insertData.publish_at = publishAt;

      const { data, error } = await supabase
        .from('posts')
        .insert(insertData)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (newPost) => {
      // Immediately prepend the new post to the feed cache so it shows without refresh
      queryClient.setQueriesData<any>(
        { queryKey: ['posts', 'friends-feed'] },
        (old: any) => {
          if (!old?.pages) return old;
          // Build a minimal enriched post for the cache
          const profile = queryClient.getQueryData<any>(['profile', user?.id]);
          const optimisticPost = {
            id: newPost.id,
            user_id: newPost.user_id,
            body: newPost.body,
            image_url: newPost.image_url,
            media_thumbnail_url: newPost.media_thumbnail_url,
            created_at: newPost.created_at,
            expires_at: newPost.expires_at || null,
            profile: {
              name: profile?.name || user?.user_metadata?.name || 'Moi',
              avatar_url: profile?.avatar_url || null,
              mood_emoji: profile?.mood_emoji || null,
            },
            likes_count: 0,
            comments_count: 0,
            is_liked: false,
            user_reaction: null,
          };
          return {
            ...old,
            pages: [
              prependFeedPageItem(old.pages[0], optimisticPost),
              ...old.pages.slice(1),
            ],
          };
        }
      );
      // Also invalidate to get accurate data on next fetch
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}

export function useDeletePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (postId: string) => {
      // Fetch the post to get media URL before deleting
      const { data: post } = await supabase
        .from('posts')
        .select('image_url, media_thumbnail_url')
        .eq('id', postId)
        .single();

      const { error } = await supabase.from('posts').delete().eq('id', postId);
      if (error) throw error;

      // Delete media from R2 if present
      if (post?.image_url) {
        try {
          const { deleteFromR2 } = await import('@/lib/r2');
          const pathMatch = extractR2Path(post.image_url);
          if (pathMatch) await deleteFromR2(pathMatch);
        } catch (e) {
          console.error('R2 media cleanup error:', e);
        }
      }
      if (post?.media_thumbnail_url) {
        try {
          const { deleteFromR2 } = await import('@/lib/r2');
          const pathMatch = extractR2Path(post.media_thumbnail_url);
          if (pathMatch) await deleteFromR2(pathMatch);
        } catch (error) {
          console.error('R2 thumbnail cleanup error:', error);
        }
      }
    },
    onMutate: async (postId) => {
      await queryClient.cancelQueries({ queryKey: ['posts'] });

      // Optimistically remove from feed cache
      queryClient.setQueriesData<any>(
        { queryKey: ['posts', 'friends-feed'] },
        (old: any) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page: any[]) =>
              replaceFeedPageItems(page as any, page.filter((p: any) => p.id !== postId))
            ),
          };
        }
      );

      // Also remove from user posts cache
      queryClient.setQueriesData<any>(
        { queryKey: ['posts', 'user'] },
        (old: any) => {
          if (!Array.isArray(old)) return old;
          return old.filter((p: any) => p.id !== postId);
        }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}

/** Extract R2 file path from a full R2 public URL */
function extractR2Path(url: string): string | null {
  try {
    const u = new URL(url);
    // Remove leading slash
    return u.pathname.replace(/^\//, '');
  } catch {
    return null;
  }
}

export function useToggleLike() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ postId, isLiked }: { postId: string; isLiked: boolean }) => {
      if (!user) throw new Error('Not authenticated');

      // ML signal: track explicit like/unlike
      try {
        const { trackMLSignal } = await import('@/hooks/useMLTracker');
        trackMLSignal(user.id, postId, isLiked ? 'skip_fast' : 'like');
      } catch {}

      if (isLiked) {
        const { error } = await supabase.from('likes').delete().eq('user_id', user.id).eq('post_id', postId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('likes').insert({
          user_id: user.id,
          post_id: postId,
          reaction_type: 'like',
        });
        if (error) throw error;

        const { data: post } = await supabase.from('posts').select('user_id').eq('id', postId).single();

        if (post && post.user_id !== user.id) {
          await supabase.from('notifications').insert({
            user_id: post.user_id,
            type: 'like',
            actor_id: user.id,
            post_id: postId,
          });
        }
      }
    },
    onMutate: async ({ postId, isLiked }) => {
      await queryClient.cancelQueries({ queryKey: ['posts', 'friends-feed'] });
      const previous = queryClient.getQueriesData({ queryKey: ['posts', 'friends-feed'] });

      queryClient.setQueriesData({ queryKey: ['posts', 'friends-feed'] }, (old: any) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((page: any[]) =>
            replaceFeedPageItems(
              page as any,
              page.map((p: any) =>
                p.id === postId
                  ? {
                      ...p,
                      is_liked: !isLiked,
                      user_reaction: isLiked ? null : 'like',
                      likes_count: isLiked ? Math.max(0, (p.likes_count || 0) - 1) : (p.likes_count || 0) + 1,
                    }
                  : p
              ),
            )
          ),
        };
      });

      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        context.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
      }
    },
  });
}
