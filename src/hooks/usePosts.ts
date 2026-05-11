import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { ReactionType } from '@/hooks/useReactions';
import { loadContentPrefs, containsMutedKeyword } from '@/lib/feedAlgorithm';
import { enforceDiversity, getSessionAdjustment } from '@/lib/feedDiversity';

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

export function usePosts() {
  const { user, loading } = useAuth();

  return useInfiniteQuery({
    queryKey: ['posts', 'friends-feed', loading ? 'loading' : user?.id ?? 'guest'],
    queryFn: async ({ pageParam }: { pageParam: number | null }) => {
      const offset = pageParam || 0;

      // ── Guest mode: simple chronological feed (no personalization) ──
      if (!user) {
        const { data: guestPosts, error } = await supabase.rpc('get_feed_posts', {
          p_user_id: null,
          p_limit: PAGE_SIZE,
          p_offset: offset,
        });

        if (error) throw error;
        if (!guestPosts || guestPosts.length === 0) return [];

        return guestPosts.map((post: any) => {
          return {
            id: post.id,
            user_id: post.user_id,
            body: post.body,
            image_url: post.image_url,
            created_at: post.created_at,
            expires_at: post.expires_at || null,
            profile: {
              name: post.author_name || 'Utilisateur',
              avatar_url: post.author_avatar || null,
              mood_emoji: post.author_mood || null,
            },
            likes_count: post.likes_count || 0,
            comments_count: post.comments_count || 0,
            is_liked: false,
            user_reaction: null,
          } as Post;
        });
      }

      // ── Authenticated feed: server-side scoring (anti-cheat) ──
      const prefs = loadContentPrefs();

      // ── Strategy 1: Single RPC call ──
      try {
        const { data: rpcPosts, error: rpcError } = await supabase.rpc('get_feed_posts', {
          p_user_id: user.id,
          p_limit: PAGE_SIZE,
          p_offset: offset,
        });

        if (!rpcError && rpcPosts && rpcPosts.length > 0) {
          const filtered = rpcPosts.filter((p: any) => !containsMutedKeyword(p.body, prefs.mutedKeywords));

          const mapped = filtered.map((post: any) => ({
            id: post.id,
            user_id: post.user_id,
            body: post.body,
            image_url: post.image_url,
            created_at: post.created_at,
            expires_at: post.expires_at || null,
            profile: {
              name: post.author_name || 'Unknown',
              avatar_url: post.author_avatar || null,
              mood_emoji: post.author_mood || null,
            },
            likes_count: post.likes_count || 0,
            comments_count: post.comments_count || 0,
            is_liked: !!post.user_reaction,
            user_reaction: post.user_reaction || null,
          })) as Post[];

          return await serverRankPosts(mapped, user.id, prefs.feedAlgorithm);
        }
      } catch {
        // Fall through to legacy fallback
      }

      // ── Fallback: direct query + enrichment ──
      const now = new Date().toISOString();
      let query = supabase
        .from('posts')
        .select('id, user_id, body, image_url, created_at, expires_at, likes_count, comments_count')
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE * 2);

      const { data: posts, error } = await query as { data: any[] | null; error: any };
      if (error) throw error;
      if (!posts || posts.length === 0) return [];

      const filteredPosts = posts.filter(p => !containsMutedKeyword(p.body, prefs.mutedKeywords));
      const enriched = await enrichPosts(filteredPosts.slice(0, PAGE_SIZE), user.id);

      return await serverRankPosts(enriched, user.id, prefs.feedAlgorithm);
    },
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      // Use offset-based pagination
      return allPages.reduce((total, page) => total + page.length, 0);
    },
    initialPageParam: null as number | null,
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
 * Blend Monte Carlo ordering with the hybrid ML score v3.
 * v3 = v2 (classic + semantic embeddings) + watch-time predictor bonus.
 * Cold-start users (no signals yet) get the trending+interests-based feed instead.
 * Then applies session re-ranking (live boost from current-session signals)
 * and diversity (max 2 consecutive posts from same author).
 */
async function blendWithMLScore(posts: Post[], userId: string): Promise<Post[]> {
  if (!posts.length) return posts;

  // Cold start check: if user has no ML signals yet, blend trending feed
  let isColdStart = false;
  try {
    const { data: cs } = await supabase.rpc('ml_is_cold_start' as any, { p_user_id: userId });
    isColdStart = cs === true;
  } catch {}

  try {
    // BATCH SCORING: 1 RPC for all posts (was N RPC calls)
    const postIds = posts.map((p) => p.id);
    const scoreMap = new Map<string, number>();
    try {
      const { data: batchData, error: batchErr } = await supabase.rpc('ml_pareto_score_batch' as any, {
        p_user_id: userId,
        p_post_ids: postIds,
      });
      if (!batchErr && Array.isArray(batchData)) {
        for (const row of batchData as Array<{ post_id: string; score: number }>) {
          scoreMap.set(row.post_id, Number(row.score) || 0.5);
        }
      }
    } catch {
      // Fallback: legacy ml_pareto_score per-post if batch unavailable
      try {
        const results = await Promise.all(
          posts.map(async (p) => {
            const { data } = await supabase.rpc('ml_pareto_score' as any, {
              p_user_id: userId,
              p_post_id: p.id,
            });
            return [p.id, typeof data === 'number' ? data : 0.5] as const;
          })
        );
        for (const [id, s] of results) scoreMap.set(id, s);
      } catch {}
    }

    const scores = posts.map((p, idx) => {
      const mcScore = 1 - idx / posts.length; // position decay (0..1)
      const mlScore = scoreMap.get(p.id) ?? 0.5;

      // Cold start: weight more on freshness/MC, less on ML (which is unreliable)
      const weights = isColdStart ? { mc: 0.7, ml: 0.3 } : { mc: 0.5, ml: 0.5 };
      let finalScore = mcScore * weights.mc + mlScore * weights.ml;

      // Live session adjustment (±0.15) based on current-session interactions
      finalScore += getSessionAdjustment(p.user_id);

      return { post: p, finalScore };
    });

    const sorted = scores.sort((a, b) => b.finalScore - a.finalScore).map((s) => s.post);
    // Enforce diversity: avoid same author dominating
    return enforceDiversity(sorted, 2);
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
