import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

import { ReactionType } from '@/hooks/useReactions';

export interface Comment {
  id: string;
  user_id: string | null;
  post_id: string;
  body: string;
  created_at: string;
  parent_id: string | null;
  is_zeus_reply?: boolean;
  profile: {
    name: string;
    avatar_url: string | null;
  };
  likes_count: number;
  is_liked: boolean;
  user_reaction: ReactionType | null;
  replies?: Comment[];
}

export function useComments(postId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['comments', postId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('comments')
        .select('id, user_id, post_id, body, created_at, parent_id, is_zeus_reply')
        .eq('post_id', postId)
        .order('created_at', { ascending: true })
        .limit(100);

      if (error) throw error;

      // Get profile info
      const userIds = [...new Set(data.map(c => c.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      // Get like counts for all comments
      const commentIds = data.map(c => c.id);
      const { data: allLikes } = await supabase
        .from('comment_likes')
        .select('comment_id, user_id, reaction_type')
        .in('comment_id', commentIds);

      const likesCountMap = new Map<string, number>();
      const userReactionMap = new Map<string, ReactionType>();
      allLikes?.forEach(l => {
        likesCountMap.set(l.comment_id, (likesCountMap.get(l.comment_id) || 0) + 1);
        if (user && l.user_id === user.id) {
          userReactionMap.set(l.comment_id, (l.reaction_type as ReactionType) || 'like');
        }
      });

      const enriched: Comment[] = data.map(comment => {
        const profile = profileMap.get(comment.user_id);
        const userReaction = userReactionMap.get(comment.id) || null;
        return {
          id: comment.id,
          user_id: comment.user_id,
          post_id: comment.post_id,
          body: comment.body,
          created_at: comment.created_at,
          parent_id: comment.parent_id,
          profile: {
            name: profile?.name || 'Unknown',
            avatar_url: profile?.avatar_url || null,
          },
          likes_count: likesCountMap.get(comment.id) || 0,
          is_liked: !!userReaction,
          user_reaction: userReaction,
        };
      });

      // Build tree: top-level + replies
      const topLevel = enriched.filter(c => !c.parent_id);
      const repliesMap = new Map<string, Comment[]>();
      enriched.filter(c => c.parent_id).forEach(c => {
        const arr = repliesMap.get(c.parent_id!) || [];
        arr.push(c);
        repliesMap.set(c.parent_id!, arr);
      });
      topLevel.forEach(c => {
        c.replies = repliesMap.get(c.id) || [];
      });

      return topLevel;
    },
    enabled: !!postId,
    staleTime: 30_000,
  });
}

// Client-side rate limiter for comments
let lastCommentTime = 0;
const COMMENT_COOLDOWN_MS = 3000;

export function useCreateComment() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ postId, body, parentId }: { postId: string; body: string; parentId?: string }) => {
      if (!user) throw new Error('Not authenticated');

      const now = Date.now();
      if (now - lastCommentTime < COMMENT_COOLDOWN_MS) {
        throw new Error('Attendez quelques secondes avant de commenter à nouveau.');
      }
      lastCommentTime = now;

      const sanitizedBody = body.replace(/<[^>]*>/g, '').trim().slice(0, 1000);
      if (!sanitizedBody) throw new Error('Le commentaire ne peut pas être vide.');

      const { data, error } = await supabase
        .from('comments')
        .insert({
          user_id: user.id,
          post_id: postId,
          body: sanitizedBody,
          parent_id: parentId || null,
        } as any)
        .select()
        .single();

      if (error) throw error;

      // Notification for post owner
      const { data: post } = await supabase
        .from('posts')
        .select('user_id')
        .eq('id', postId)
        .single();

      if (post && post.user_id !== user.id) {
        await supabase.from('notifications').insert({
          user_id: post.user_id,
          type: 'comment',
          actor_id: user.id,
          post_id: postId,
        });
      }

      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['comments', variables.postId] });
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}

export function useDeleteComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ commentId, postId }: { commentId: string; postId: string }) => {
      const { error } = await supabase
        .from('comments')
        .delete()
        .eq('id', commentId);

      if (error) throw error;
      return postId;
    },
    onSuccess: (postId) => {
      queryClient.invalidateQueries({ queryKey: ['comments', postId] });
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}

export function useLikeComment() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ commentId, postId, action, reactionType }: { commentId: string; postId: string; action: 'add' | 'remove'; reactionType?: ReactionType }) => {
      if (!user) throw new Error('Not authenticated');

      if (action === 'remove') {
        const { error } = await supabase.from('comment_likes').delete().eq('comment_id', commentId).eq('user_id', user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('comment_likes').upsert(
          { comment_id: commentId, user_id: user.id, reaction_type: reactionType || 'like' } as any,
          { onConflict: 'comment_id,user_id' }
        );
        if (error) throw error;
      }
      return postId;
    },
    onSuccess: (postId) => {
      queryClient.invalidateQueries({ queryKey: ['comments', postId] });
    },
    onError: (err: any) => {
      console.error('Comment like error:', err?.message || err);
    },
  });
}
