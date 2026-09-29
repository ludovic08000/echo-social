import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { ReactionType } from '@/hooks/useReactions';
import { loadContentPrefs, containsMutedKeyword } from '@/lib/feedAlgorithm';
import { getSessionAdjustment } from '@/lib/feedDiversity';
import { syncFeedPrefsFromServer } from '@/lib/feedPreferences';
import { mapFeedRpcRow } from '@/lib/recsysV8';
import { buildFeedPage, createInitialFeedCursor, type FeedCursor } from '@/lib/feedPagination';
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
  id: string;
  user_id: string;
  body: string;
  image_url: string | null;
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

const PAGE_SIZE = 25;

type FeedRpcResponse = {
  data?: unknown[] | null;
  error?: unknown;
};

function feedClockNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

async function runTimedFeedRpc<T extends FeedRpcResponse>(
  source: 'get_feed_posts_v8' | 'get_feed_posts',
  offset: number,
  request: () => PromiseLike<T>,
): Promise<T> {
  const startedAt = feedClockNow();
  try {
    const result = await request();
    emitFeedPerformanceMetric('rpc_latency', feedClockNow() - startedAt, {
      source,
      page: offset === 0 ? 'initial' : 'next',
      outcome: result.error ? 'error' : 'success',
      row_count: Array.isArray(result.data) ? result.data.length : 0,
      target_max_ms: 350,
    });
    return result;
  } catch (error) {
    emitFeedPerformanceMetric('rpc_latency', feedClockNow() - startedAt, {
      source,
      page: offset === 0 ? 'initial' : 'next',
      outcome: 'exception',
      target_max_ms: 350,
    });
    throw error;
  }
}

export function usePosts() {
  const { user, loading } = useAuth();

  return useInfiniteQuery({
    queryKey: ['posts', 'friends-feed', loading ? 'loading' : user?.id ?? 'guest'],
    queryFn: async ({ pageParam }: { pageParam: FeedCursor }) => {
      const cursor = pageParam;
      const offset = cursor.offset;

      // ── Guest mode: simple chronological feed (no personalization) ──
      if (!user) {
        const v8 = await runTimedFeedRpc('get_feed_posts_v8', offset, () =>
          (supabase.rpc as any)('get_feed_posts_v8', {
            p_user_id: null,
            p_limit: PAGE_SIZE,
            p_offset: offset,
          }),
        );

        const legacy = v8.error
          ? await runTimedFeedRpc('get_feed_posts', offset, () =>
              supabase.rpc('get_feed_posts', {
                p_user_id: null,
                p_limit: PAGE_SIZE,
                p_offset: offset,
              }),
            )
          : { data: v8.data, error: null };

        const { data: guestPosts, error } = legacy;

        if (error) throw error;
        const mapped = (guestPosts || []).map((post: any) => ({
          ...(mapFeedRpcRow(post) as Post),
          is_liked: false,
          user_reaction: null,
        }));
        return buildFeedPage<Post>(mapped, cursor, { fetchSize: PAGE_SIZE });
      }

      // ── Authenticated feed: server-side scoring (anti-cheat) ──
      const prefsSyncPromise = ensureFeedPrefsSynced(user.id).catch(() => undefined);

      // ── Strategy 1: one ranked RPC, while preference hydration runs in
      // parallel. The server already reads the authoritative preference row;
      // awaiting both only ensures the local muted-keyword cache is fresh
      // before rendering, without paying two sequential network round-trips.
      try {
        const v8Promise = runTimedFeedRpc('get_feed_posts_v8', offset, () =>
          (supabase.rpc as any)('get_feed_posts_v8', {
            p_user_id: user.id,
            p_limit: PAGE_SIZE,
            p_offset: offset,
          }),
        );
        const [v8] = await Promise.all([v8Promise, prefsSyncPromise]);
        const prefs = loadContentPrefs();

        const legacy = v8.error
          ? await runTimedFeedRpc('get_feed_posts', offset, () =>
              supabase.rpc('get_feed_posts', {
                p_user_id: user.id,
                p_limit: PAGE_SIZE,
                p_offset: offset,
              }),
            )
          : { data: v8.data, error: null };

        const { data: rpcPosts, error: rpcError } = legacy;

        if (!rpcError) {
          const mapped = (rpcPosts || []).map((post: any) => mapFeedRpcRow(post) as Post);
          return buildFeedPage<Post>(mapped, cursor, {
            fetchSize: PAGE_SIZE,
            include: (post) => !containsMutedKeyword(post.body, prefs.mutedKeywords),
            maxConsecutiveSameAuthor: 2,
          });
        }
      } catch {
        // Fall through to legacy fallback
      }

      await prefsSyncPromise;
      const prefs = loadContentPrefs();

      // ── Fallback: direct query + enrichment ──
      const now = new Date().toISOString();
      const query = supabase
        .from('posts')
        .select('id, user_id, body, image_url, created_at, expires_at, likes_count, comments_count')
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      const { data: posts, error } = await query as { data: any[] | null; error: any };
      if (error) throw error;
      if (!posts || posts.length === 0) {
        return buildFeedPage<Post>([], cursor, { fetchSize: PAGE_SIZE });
      }

      const enriched = await enrichPosts(posts, user.id);
      const ranked = await serverRankPosts(enriched, user.id, prefs.feedAlgorithm);
      return buildFeedPage<Post>(ranked, cursor, {
        fetchSize: PAGE_SIZE,
        include: (post) => !containsMutedKeyword(post.body, prefs.mutedKeywords),
        maxConsecutiveSameAuthor: 2,
      });
    },
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
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
  });
}

/**
 * Server-side ranking via `feed_score_batch` RPC (Phase A anti-cheat).
 * All scoring weights, ML blend, recency, friend boost, late-night dampener
 * live in Postgres — the client only renders the order received.
 * Light client polish kept: session adjustment (current-session signals)
 * and author diversity (max 2 consecutive posts from same author).
 */
async function serverRankPosts(
  posts: Post[],
  userId: string,
  algo: 'smart' | 'chronological' | 'friends_first',
): Promise<Post[]> {
  if (!posts.length) return posts;

  // Chronological: skip RPC, server already ordered by created_at desc
  if (algo === 'chronological') {
    return posts;
  }

  try {
    const postIds = posts.map((p) => p.id);
    const { data, error } = await supabase.rpc('feed_score_batch' as any, {
      p_user_id: userId,
      p_post_ids: postIds,
      p_algo: algo,
    });

    if (error || !Array.isArray(data) || data.length === 0) {
      return posts;
    }

    const scoreMap = new Map<string, number>();
    for (const row of data as Array<{ post_id: string; final_score: number }>) {
      scoreMap.set(row.post_id, Number(row.final_score) || 0);
    }

    const scored = posts.map((p) => {
      const base = scoreMap.get(p.id) ?? 0;
      // Live session adjustment (±0.15) — small client tie-break, not gameable for global ranking
      return { post: p, finalScore: base + getSessionAdjustment(p.user_id) * 5 };
    });

    const sorted = scored.sort((a, b) => b.finalScore - a.finalScore).map((s) => s.post);
    return sorted;
  } catch {
    return posts;
  }
}

/** Enrich posts with profiles and user reactions — shared between strategies */
async function enrichPosts(posts: any[], userId: string): Promise<Post[]> {
  const userIds = [...new Set(posts.map(p => p.user_id))];
  const postIds = posts.map(p => p.id);

  const [profilesRes, userLikesRes] = await Promise.all([
    supabase.from('profiles').select('user_id, name, avatar_url, mood_emoji').in('user_id', userIds),
    supabase.from('likes').select('post_id, reaction_type').eq('user_id', userId).in('post_id', postIds),
  ]);

  const profileMap = new Map(profilesRes.data?.map(p => [p.user_id, p]) || []);
  const userReactions = new Map<string, ReactionType>();
  userLikesRes.data?.forEach((l: { post_id: string; reaction_type: ReactionType }) => {
    userReactions.set(l.post_id, l.reaction_type);
  });

  return posts.map(post => {
    const profile = profileMap.get(post.user_id);
    const userReaction = userReactions.get(post.id);
    return {
      id: post.id,
      user_id: post.user_id,
      body: post.body,
      image_url: post.image_url,
      created_at: post.created_at,
      expires_at: post.expires_at || null,
      profile: {
        name: profile?.name || 'Unknown',
        avatar_url: profile?.avatar_url || null,
        mood_emoji: (profile as any)?.mood_emoji || null,
      },
      likes_count: post.likes_count || 0,
      comments_count: post.comments_count || 0,
      is_liked: !!userReaction,
      user_reaction: userReaction || null,
    };
  });
}

export function useUserPosts(userId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['posts', 'user', userId],
    queryFn: async () => {
      const { data: posts, error } = await supabase
        .from('posts')
        .select('id, user_id, body, image_url, created_at, expires_at')
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
    mutationFn: async ({ body, imageUrl, expiresAt, publishAt }: { body: string; imageUrl?: string; expiresAt?: string; publishAt?: string }) => {
      if (!user) throw new Error('Not authenticated');

      // Sanitize: strip HTML tags and limit length
      const sanitizedBody = body.replace(/<[^>]*>/g, '').slice(0, 5000);

      const insertData: any = {
        user_id: user.id,
        body: sanitizedBody,
        image_url: imageUrl || null,
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
              [optimisticPost, ...old.pages[0]],
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
        .select('image_url')
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
              page.filter((p: any) => p.id !== postId)
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
            page.map((p: any) =>
              p.id === postId
                ? {
                    ...p,
                    is_liked: !isLiked,
                    user_reaction: isLiked ? null : 'like',
                    likes_count: isLiked ? Math.max(0, (p.likes_count || 0) - 1) : (p.likes_count || 0) + 1,
                  }
                : p
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
