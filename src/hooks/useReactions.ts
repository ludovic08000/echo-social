import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  applyPostReaction,
  removePostReaction,
  updatePostInReactionCache,
} from '@/lib/postReactionCache';

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

interface SetReactionInput {
  postId: string;
  reactionType: ReactionType;
  previousReaction: ReactionType | null;
}

export function useAddReaction() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ postId, reactionType, previousReaction }: SetReactionInput) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('likes')
        .upsert({
          user_id: user.id,
          post_id: postId,
          reaction_type: reactionType,
        }, { onConflict: 'user_id,post_id' })
        .select('reaction_type')
        .single();

      if (error) throw error;
      if (data?.reaction_type !== reactionType) {
        throw new Error('POST_REACTION_NOT_PERSISTED');
      }

      // Replacing an existing reaction is not a new engagement notification.
      if (previousReaction === null) {
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
      }
    },
    onMutate: async ({ postId, reactionType, previousReaction }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['posts'] }),
        queryClient.cancelQueries({ queryKey: ['post', postId] }),
      ]);

      const previousPosts = queryClient.getQueriesData({ queryKey: ['posts'] });
      const previousPost = queryClient.getQueryData(['post', postId]);

      queryClient.setQueriesData({ queryKey: ['posts'] }, (old: unknown) =>
        updatePostInReactionCache(
          old,
          postId,
          (post) => applyPostReaction(post, reactionType, previousReaction !== null),
        )
      );
      queryClient.setQueryData(['post', postId], (old: unknown) =>
        updatePostInReactionCache(
          old,
          postId,
          (post) => applyPostReaction(post, reactionType, previousReaction !== null),
        )
      );

      return { previousPosts, previousPost, postId };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPosts) {
        context.previousPosts.forEach(([key, data]) => {
          queryClient.setQueryData(key, data);
        });
      }
      if (context) queryClient.setQueryData(['post', context.postId], context.previousPost);
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      queryClient.invalidateQueries({ queryKey: ['post', variables.postId] });
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
        queryClient.cancelQueries({ queryKey: ['post', postId] }),
      ]);

      const previousPosts = queryClient.getQueriesData({ queryKey: ['posts'] });
      const previousPost = queryClient.getQueryData(['post', postId]);

      queryClient.setQueriesData({ queryKey: ['posts'] }, (old: unknown) =>
        updatePostInReactionCache(old, postId, removePostReaction)
      );
      queryClient.setQueryData(['post', postId], (old: unknown) =>
        updatePostInReactionCache(old, postId, removePostReaction)
      );

      return { previousPosts, previousPost, postId };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPosts) {
        context.previousPosts.forEach(([key, data]) => {
          queryClient.setQueryData(key, data);
        });
      }
      if (context) queryClient.setQueryData(['post', context.postId], context.previousPost);
    },
    onSettled: (_data, _error, postId) => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      queryClient.invalidateQueries({ queryKey: ['post', postId] });
    },
  });
}
