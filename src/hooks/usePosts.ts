import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { ReactionType } from '@/hooks/useReactions';
import { useEffect } from 'react';
import {
  scorePost,
  loadContentPrefs,
  loadFeedWeights,
  containsMutedKeyword,
  type ScoringContext,
} from '@/lib/feedAlgorithm';

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

const PAGE_SIZE = 10;

export function usePosts() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Realtime: only listen for new posts (INSERT), not every like/comment change
  // Likes/comments counts update on next staleTime refresh — saves massive DB reads
  useEffect(() => {
    const channel = supabase
      .channel('posts-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, () => {
        queryClient.invalidateQueries({ queryKey: ['posts'] });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, () => {
        queryClient.invalidateQueries({ queryKey: ['posts'] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  return useInfiniteQuery({
    queryKey: ['posts', 'friends-feed', user?.id],
    queryFn: async ({ pageParam = 0 }) => {
      if (!user) return [];
      
      const prefs = loadContentPrefs();
      const weights = loadFeedWeights();
      const from = pageParam * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      // Get friends
      const { data: friendships } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

      const friendIds = friendships?.map(f => 
        f.requester_id === user.id ? f.addressee_id : f.requester_id
      ) || [];

      const allowedUserIds = [user.id, ...friendIds];
      const now = new Date().toISOString();

      // Fetch larger pool for scoring
      const poolSize = PAGE_SIZE * 3;
      const { data: posts, error } = await supabase
        .from('posts')
        .select('id, user_id, body, image_url, created_at, expires_at')
        .in('user_id', allowedUserIds)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('created_at', { ascending: false })
        .range(0, Math.max(to, poolSize - 1));

      if (error) throw error;
      if (!posts || posts.length === 0) return [];

      // ── ANTI-SPAM: Filter muted keywords ──
      const filteredPosts = posts.filter(p => !containsMutedKeyword(p.body, prefs.mutedKeywords));

      const userIds = [...new Set(filteredPosts.map(p => p.user_id))];
      const postIds = filteredPosts.map(p => p.id);
      
      const [profilesRes, likesRes, commentsRes, userLikesRes, interactionsRes] = await Promise.all([
        supabase.from('profiles').select('user_id, name, avatar_url, mood_emoji').in('user_id', userIds),
        supabase.from('likes').select('post_id').in('post_id', postIds),
        supabase.from('comments').select('post_id').in('post_id', postIds),
        supabase.from('likes').select('post_id, reaction_type').eq('user_id', user.id).in('post_id', postIds),
        supabase.from('likes').select('post_id').eq('user_id', user.id).limit(200),
      ]);

      const profileMap = new Map(profilesRes.data?.map(p => [p.user_id, p]) || []);

      const likesCount: Record<string, number> = {};
      const commentsCount: Record<string, number> = {};
      const userReactions = new Map<string, ReactionType>();

      likesRes.data?.forEach(l => { likesCount[l.post_id] = (likesCount[l.post_id] || 0) + 1; });
      commentsRes.data?.forEach(c => { commentsCount[c.post_id] = (commentsCount[c.post_id] || 0) + 1; });
      userLikesRes.data?.forEach((l: { post_id: string; reaction_type: ReactionType }) => {
        userReactions.set(l.post_id, l.reaction_type);
      });

      // Build friend interaction map
      const friendInteractionCounts = new Map<string, number>();
      if (interactionsRes.data) {
        const likedPostIds = interactionsRes.data.map(l => l.post_id);
        if (likedPostIds.length > 0) {
          const { data: likedPosts } = await supabase
            .from('posts')
            .select('user_id')
            .in('id', likedPostIds.slice(0, 200));
          likedPosts?.forEach(p => {
            friendInteractionCounts.set(p.user_id, (friendInteractionCounts.get(p.user_id) || 0) + 1);
          });
        }
      }

      // ── SCORING with anti-bias diversity tracking ──
      const seenAuthors = new Set<string>();
      const ctx: ScoringContext = {
        friendInteractionCounts,
        userId: user.id,
        prefs,
        weights,
        seenAuthors,
        postIndex: 0,
      };

      const enrichedPosts = filteredPosts.map((post, index) => {
        const profile = profileMap.get(post.user_id);
        const userReaction = userReactions.get(post.id);
        const lc = likesCount[post.id] || 0;
        const cc = commentsCount[post.id] || 0;

        ctx.postIndex = index;
        const _score = scorePost(
          { ...post, likes_count: lc, comments_count: cc },
          ctx
        );
        
        // Track author for diversity
        seenAuthors.add(post.user_id);

        return {
          id: post.id,
          user_id: post.user_id,
          body: post.body,
          image_url: post.image_url,
          created_at: post.created_at,
          expires_at: (post as any).expires_at || null,
          profile: {
            name: profile?.name || 'Unknown',
            avatar_url: profile?.avatar_url || null,
            mood_emoji: (profile as any)?.mood_emoji || null,
          },
          likes_count: lc,
          comments_count: cc,
          is_liked: !!userReaction,
          user_reaction: userReaction || null,
          _score,
        };
      });

      // Sort by score
      enrichedPosts.sort((a, b) => b._score - a._score);

      // ── ANTI-BIAS: Enforce max consecutive posts from same author ──
      const diversified: typeof enrichedPosts = [];
      const authorConsecutive = new Map<string, number>();
      const maxConsecutive = 2;
      const deferred: typeof enrichedPosts = [];

      for (const post of enrichedPosts) {
        const consecutive = authorConsecutive.get(post.user_id) || 0;
        if (consecutive >= maxConsecutive) {
          deferred.push(post);
        } else {
          diversified.push(post);
          // Reset other authors, increment this one
          authorConsecutive.clear();
          authorConsecutive.set(post.user_id, consecutive + 1);
        }
      }
      // Append deferred at end
      diversified.push(...deferred);

      const paged = diversified.slice(from, to + 1);
      return paged.map(({ _score, ...post }) => post);
    },
    getNextPageParam: (lastPage, pages) => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      return pages.length;
    },
    initialPageParam: 0,
    enabled: !!user,
    staleTime: 60_000,       // 1 min cache — avoid refetch on every tab focus
    gcTime: 5 * 60_000,      // Keep in memory 5 min
    refetchInterval: 120_000, // Refresh every 2 min instead of 1
    refetchOnWindowFocus: false,
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

      const insertData: any = {
        user_id: user.id,
        body,
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}

export function useDeletePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (postId: string) => {
      const { error } = await supabase.from('posts').delete().eq('id', postId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}

export function useToggleLike() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ postId, isLiked }: { postId: string; isLiked: boolean }) => {
      if (!user) throw new Error('Not authenticated');

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}
