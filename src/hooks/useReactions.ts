import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';

export const REACTION_EMOJIS: Record<ReactionType, string> = {
  like: '👍',
  love: '❤️',
  haha: '😂',
  wow: '😮',
  sad: '😢',
  angry: '😠',
};

export const REACTION_LABELS: Record<ReactionType, string> = {
  like: 'J\'aime',
  love: 'J\'adore',
  haha: 'Haha',
  wow: 'Wow',
  sad: 'Triste',
  angry: 'Grrr',
};

export function useAddReaction() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ postId, reactionType }: { postId: string; reactionType: ReactionType }) => {
      if (!user) throw new Error('Not authenticated');

      // Remove existing reaction first
      await supabase
        .from('likes')
        .delete()
        .eq('user_id', user.id)
        .eq('post_id', postId);

      // Insert new reaction
      const { error } = await supabase
        .from('likes')
        .insert({
          user_id: user.id,
          post_id: postId,
          reaction_type: reactionType,
        });

      if (error) throw error;

      // Notification in separate try/catch — NEVER blocks the reaction
      try {
        const { data: post } = await supabase
          .from('posts')
          .select('user_id')
          .eq('id', postId)
          .single();

        if (post && post.user_id !== user.id) {
          await supabase.from('notifications').insert({
            user_id: post.user_id,
            type: 'reaction',
            actor_id: user.id,
            post_id: postId,
          });
        }
      } catch (notifErr) {
        console.warn('[Reactions] Notification failed (non-blocking):', notifErr);
      }
    },
    onMutate: async ({ postId, reactionType }) => {
      await queryClient.cancelQueries({ queryKey: ['posts'] });
      const previousPosts = queryClient.getQueriesData({ queryKey: ['posts'] });

      queryClient.setQueriesData({ queryKey: ['posts'] }, (old: any) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((page: any[]) =>
            page.map((post: any) => {
              if (post.id !== postId) return post;
              const hadReaction = !!post.user_reaction;
              return {
                ...post,
                user_reaction: reactionType,
                is_liked: true,
                likes_count: hadReaction ? post.likes_count : (post.likes_count || 0) + 1,
              };
            })
          ),
        };
      });

      return { previousPosts };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPosts) {
        context.previousPosts.forEach(([key, data]) => {
          queryClient.setQueryData(key, data);
        });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}

export function useRemoveReaction() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (postId: string) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('likes')
        .delete()
        .eq('user_id', user.id)
        .eq('post_id', postId);

      if (error) throw error;
    },
    onMutate: async (postId) => {
      await queryClient.cancelQueries({ queryKey: ['posts'] });
      const previousPosts = queryClient.getQueriesData({ queryKey: ['posts'] });

      queryClient.setQueriesData({ queryKey: ['posts'] }, (old: any) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((page: any[]) =>
            page.map((post: any) => {
              if (post.id !== postId) return post;
              return {
                ...post,
                user_reaction: null,
                is_liked: false,
                likes_count: Math.max(0, (post.likes_count || 0) - 1),
              };
            })
          ),
        };
      });

      return { previousPosts };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPosts) {
        context.previousPosts.forEach(([key, data]) => {
          queryClient.setQueryData(key, data);
        });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}
