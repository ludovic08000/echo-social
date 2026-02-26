import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { ReactionType } from '@/hooks/useReactions';
import { useEffect } from 'react';

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

// ────────────────────────────────────────────────────────
// Algorithme d'engagement agressif
// Score chaque post pour maximiser le temps passé sur le feed
// ────────────────────────────────────────────────────────

interface ScoringContext {
  friendInteractionCounts: Map<string, number>; // userId -> nb interactions mutuelles
  userId: string;
}

function scorePost(
  post: { 
    id: string; 
    user_id: string; 
    body: string; 
    image_url: string | null; 
    created_at: string;
    likes_count: number;
    comments_count: number;
  },
  ctx: ScoringContext
): number {
  let score = 0;

  // 1. ENGAGEMENT VIRAL — les posts populaires attirent plus
  const engagementRatio = (post.likes_count * 1.0 + post.comments_count * 2.5);
  score += Math.min(40, engagementRatio * 2);

  // 2. PROXIMITÉ SOCIALE — amis proches en priorité
  const interactionCount = ctx.friendInteractionCounts.get(post.user_id) || 0;
  score += Math.min(30, interactionCount * 5);

  // 3. CONTENU RICHE — les images captent plus l'attention
  if (post.image_url) {
    score += 15;
  }

  // 4. LONGUEUR DU TEXTE — les posts moyens engagent plus (ni trop courts, ni trop longs)
  const textLen = post.body.length;
  if (textLen > 50 && textLen < 500) score += 8;
  else if (textLen >= 500) score += 4;

  // 5. RÉCENCE avec décroissance exponentielle — favorise le contenu frais
  const ageMs = Date.now() - new Date(post.created_at).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const recencyBoost = Math.max(0, 25 * Math.exp(-ageHours / 12)); // demi-vie de 12h
  score += recencyBoost;

  // 6. POST PROPRE DE L'UTILISATEUR — boost léger pour voir ses propres posts
  if (post.user_id === ctx.userId) {
    score += 5;
  }

  // 7. RANDOMISATION CONTRÔLÉE — empêche le feed d'être trop prévisible
  score += Math.random() * 8;

  // 8. ÉMOJI / RÉACTIONS — posts avec émojis = plus d'émotions
  const hasEmoji = /[\u{1F300}-\u{1F9FF}]/u.test(post.body);
  if (hasEmoji) score += 3;

  return score;
}

export function usePosts() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Subscribe to realtime changes
  useEffect(() => {
    const channel = supabase
      .channel('posts-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, () => {
        queryClient.invalidateQueries({ queryKey: ['posts'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'likes' }, () => {
        queryClient.invalidateQueries({ queryKey: ['posts'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, () => {
        queryClient.invalidateQueries({ queryKey: ['posts'] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  return useInfiniteQuery({
    queryKey: ['posts', 'friends-feed', user?.id],
    queryFn: async ({ pageParam = 0 }) => {
      if (!user) return [];
      
      const from = pageParam * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      // Get list of friend user IDs
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

      // Fetch a larger pool for scoring (3x page size)
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

      // Get profiles, likes, comments in parallel
      const userIds = [...new Set(posts.map(p => p.user_id))];
      const postIds = posts.map(p => p.id);
      
      const [profilesRes, likesRes, commentsRes, userLikesRes, interactionsRes] = await Promise.all([
        supabase.from('profiles').select('user_id, name, avatar_url, mood_emoji').in('user_id', userIds),
        supabase.from('likes').select('post_id').in('post_id', postIds),
        supabase.from('comments').select('post_id').in('post_id', postIds),
        supabase.from('likes').select('post_id, reaction_type').eq('user_id', user.id).in('post_id', postIds),
        // Fetch user's interaction history with friends (likes they gave on friends' posts)
        supabase.from('likes').select('post_id')
          .eq('user_id', user.id)
          .limit(200),
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

      // Build friend interaction map (how much user interacts with each friend)
      const friendInteractionCounts = new Map<string, number>();
      // Count likes the user gave, grouped by post author
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

      // Score and sort posts
      const ctx: ScoringContext = { friendInteractionCounts, userId: user.id };
      
      const enrichedPosts = posts.map(post => {
        const profile = profileMap.get(post.user_id);
        const userReaction = userReactions.get(post.id);
        const lc = likesCount[post.id] || 0;
        const cc = commentsCount[post.id] || 0;
        
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
          _score: scorePost(
            { ...post, likes_count: lc, comments_count: cc },
            ctx
          ),
        };
      });

      // Sort by engagement score (not chronological!)
      enrichedPosts.sort((a, b) => b._score - a._score);

      // Paginate from the scored results
      const paged = enrichedPosts.slice(from, to + 1);

      return paged.map(({ _score, ...post }) => post);
    },
    getNextPageParam: (lastPage, pages) => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      return pages.length;
    },
    initialPageParam: 0,
    enabled: !!user,
    staleTime: 15000, // Refresh toutes les 15s pour du contenu frais
    refetchInterval: 60000, // Auto-refresh toutes les 60s
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
