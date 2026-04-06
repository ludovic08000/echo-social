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

function updatePostsCollection(old: any, postId: string, updater: (post: any) => any) {
  if (!old) return old;

  if (Array.isArray(old)) {
    return old.map((post: any) => (post.id === postId ? updater(post) : post));
  }

  if (old?.pages) {
    return {
      ...old,
      pages: old.pages.map((page: any[]) =>
        page.map((post: any) => (post.id === postId ? updater(post) : post))
      ),
    };
  }

  return old;
}

export function useAddReaction() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ postId, reactionType }: { postId: string; reactionType: ReactionType }) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('likes')
        .upsert({
          user_id: user.id,
          post_id: postId,
          reaction_type: reactionType,
        }, { onConflict: 'user_id,post_id' });

      if (error) throw error;

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
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['posts'] }),
        queryClient.cancelQueries({ queryKey: ['post-top-reactions', postId] }),
      ]);

      const previousPosts = queryClient.getQueriesData({ queryKey: ['posts'] });

      queryClient.setQueriesData({ queryKey: ['posts'] }, (old: any) =>
        updatePostsCollection(old, postId, (post: any) => {
          const hadReaction = !!post.user_reaction;
          return {
            ...post,
            user_reaction: reactionType,
            is_liked: true,
            likes_count: hadReaction ? post.likes_count : (post.likes_count || 0) + 1,
          };
        })
      );

      queryClient.setQueryData<ReactionType[]>(['post-top-reactions', postId], (old = []) => {
        const next = [reactionType, ...old.filter((type) => type !== reactionType)];
        return Array.from(new Set(next)).slice(0, 2);
      });

      return { previousPosts, postId };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPosts) {
        context.previousPosts.forEach(([key, data]) => {
          queryClient.setQueryData(key, data);
        });
      }
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      queryClient.invalidateQueries({ queryKey: ['post-top-reactions', variables.postId] });
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
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['posts'] }),
        queryClient.cancelQueries({ queryKey: ['post-top-reactions', postId] }),
      ]);

      const previousPosts = queryClient.getQueriesData({ queryKey: ['posts'] });

      queryClient.setQueriesData({ queryKey: ['posts'] }, (old: any) =>
        updatePostsCollection(old, postId, (post: any) => ({
          ...post,
          user_reaction: null,
          is_liked: false,
          likes_count: Math.max(0, (post.likes_count || 0) - 1),
        }))
      );

      queryClient.invalidateQueries({ queryKey: ['post-top-reactions', postId] });

      return { previousPosts, postId };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPosts) {
        context.previousPosts.forEach(([key, data]) => {
          queryClient.setQueryData(key, data);
        });
      }
    },
    onSettled: (_data, _error, postId) => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      queryClient.invalidateQueries({ queryKey: ['post-top-reactions', postId] });
    },
  });
}
