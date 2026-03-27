import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface Comment {
  id: string;
  user_id: string;
  post_id: string;
  body: string;
  created_at: string;
  profile: {
    name: string;
    avatar_url: string | null;
  };
}

export function useComments(postId: string) {
  return useQuery({
    queryKey: ['comments', postId],
    queryFn: async () => {
      // Load only the most recent 30 comments (paginated)
      const { data, error } = await supabase
        .from('comments')
        .select('id, user_id, post_id, body, created_at')
        .eq('post_id', postId)
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) throw error;

      // Reverse to show chronologically
      data.reverse();

      // Get profile info for each comment (batched, not N+1)
      const userIds = [...new Set(data.map(c => c.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      return data.map(comment => {
        const profile = profileMap.get(comment.user_id);
        return {
          id: comment.id,
          user_id: comment.user_id,
          post_id: comment.post_id,
          body: comment.body,
          created_at: comment.created_at,
          profile: {
            name: profile?.name || 'Unknown',
            avatar_url: profile?.avatar_url || null,
          },
        };
      });
    },
    enabled: !!postId,
    staleTime: 30_000, // Cache 30s to avoid re-fetching on toggle
  });
}

// Client-side rate limiter for comments
let lastCommentTime = 0;
const COMMENT_COOLDOWN_MS = 3000;

export function useCreateComment() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ postId, body }: { postId: string; body: string }) => {
      if (!user) throw new Error('Not authenticated');

      // Rate limit: 1 comment per 3 seconds
      const now = Date.now();
      if (now - lastCommentTime < COMMENT_COOLDOWN_MS) {
        throw new Error('Attendez quelques secondes avant de commenter à nouveau.');
      }
      lastCommentTime = now;

      // Sanitize: strip HTML tags, limit to 1000 chars
      const sanitizedBody = body.replace(/<[^>]*>/g, '').trim().slice(0, 1000);
      if (!sanitizedBody) throw new Error('Le commentaire ne peut pas être vide.');

      const { data, error } = await supabase
        .from('comments')
        .insert({
          user_id: user.id,
          post_id: postId,
          body: sanitizedBody,
        })
        .select()
        .single();

      if (error) throw error;

      // Create notification for post owner
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
