import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { ReactionType } from '@/hooks/useReactions';
import { loadContentPrefs, loadFeedWeights, containsMutedKeyword } from '@/lib/feedAlgorithm';

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

const PAGE_SIZE = 15;

export function usePosts() {
  const { user } = useAuth();

  return useInfiniteQuery({
    queryKey: ['posts', 'friends-feed', user?.id],
    queryFn: async ({ pageParam }: { pageParam: number | null }) => {
      if (!user) return [];
      
      const prefs = loadContentPrefs();
      const offset = pageParam || 0;

      // ── Strategy 1: Single RPC call (posts + profiles + reactions in 1 query) ──
      try {
        const { data: rpcPosts, error: rpcError } = await supabase.rpc('get_feed_posts', {
          p_user_id: user.id,
          p_limit: PAGE_SIZE,
          p_offset: offset,
        });

        if (!rpcError && rpcPosts && rpcPosts.length > 0) {
          // Filter muted keywords client-side
          const filtered = rpcPosts.filter((p: any) => !containsMutedKeyword(p.body, prefs.mutedKeywords));

          return filtered.map((post: any) => ({
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
      return await enrichPosts(filteredPosts.slice(0, PAGE_SIZE), user.id);
    },
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      // Use offset-based pagination
      return allPages.reduce((total, page) => total + page.length, 0);
    },
    initialPageParam: null as number | null,
    enabled: !!user,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchInterval: 2 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
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
    onSuccess: () => {
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
