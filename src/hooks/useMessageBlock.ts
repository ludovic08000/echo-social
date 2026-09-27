import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { invalidateFanoutRoute } from '@/lib/messaging/fanoutRouteCache';

const blockKey = (userId: string | undefined, peerUserId: string | undefined) =>
  ['message-block', userId ?? 'anon', peerUserId ?? 'none'] as const;

export function useMessageBlock(conversationId: string, peerUserId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = blockKey(user?.id, peerUserId);

  const status = useQuery({
    queryKey,
    queryFn: async () => {
      if (!user?.id || !peerUserId) return false;
      const { data, error } = await supabase.rpc(
        'aegis_get_user_message_block_status',
        { p_target_user_id: peerUserId },
      );
      if (error) throw error;
      return data === true;
    },
    enabled: Boolean(user?.id && peerUserId),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  const mutation = useMutation({
    mutationFn: async (blocked: boolean) => {
      if (!user?.id || !peerUserId) throw new Error('MESSAGE_BLOCK_TARGET_INVALID');
      const { data, error } = await supabase.rpc('aegis_set_user_message_block', {
        p_target_user_id: peerUserId,
        p_blocked: blocked,
      });
      if (error) throw error;
      return data === true;
    },
    onMutate: async (blocked) => {
      await queryClient.cancelQueries({ queryKey, exact: true });
      const previous = queryClient.getQueryData<boolean>(queryKey);
      queryClient.setQueryData(queryKey, blocked);
      return { previous };
    },
    onError: (_error, _blocked, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: (blocked) => {
      queryClient.setQueryData(queryKey, blocked);
      if (user?.id && conversationId) {
        invalidateFanoutRoute(conversationId, user.id);
        void queryClient.invalidateQueries({
          queryKey: ['messages', conversationId, user.id],
          exact: true,
        });
        void queryClient.invalidateQueries({
          queryKey: ['conversations', user.id],
          exact: true,
        });
      }
    },
  });

  return {
    isBlockedByMe: status.data === true,
    isLoading: status.isLoading,
    setBlocked: mutation.mutateAsync,
    isChanging: mutation.isPending,
  };
}
