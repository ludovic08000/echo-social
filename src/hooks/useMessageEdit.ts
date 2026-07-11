import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { canEditMessage, createEncryptedMessageEdit } from '@/lib/messaging/messageEdits';
import { loadMessageEditContext, type MessageEditContext } from '@/lib/messaging/messageEditContext';
import { retainMessageEditRealtime } from '@/lib/messaging/messageEditRealtime';

export function useMessageEdit(messageId?: string, enabled = true) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const active = Boolean(enabled && messageId && user);

  useEffect(() => {
    if (!active || !user) return;
    return retainMessageEditRealtime(user.id, queryClient);
  }, [active, user?.id, queryClient]);

  const queryKey = ['message-edit', messageId ?? 'none', user?.id ?? 'anon'] as const;
  const contextQuery = useQuery({
    queryKey,
    enabled: active,
    queryFn: () => loadMessageEditContext(messageId!, user!.id),
    staleTime: 10_000,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });

  const mutation = useMutation({
    mutationFn: async (plaintext: string) => {
      const meta = contextQuery.data?.meta;
      if (!user || !meta) throw new Error('Message introuvable.');
      return createEncryptedMessageEdit({
        message: meta,
        currentUserId: user.id,
        plaintext,
      });
    },
    onSuccess: (resolved) => {
      queryClient.setQueryData<MessageEditContext>(queryKey, (previous) => ({
        meta: previous?.meta ?? null,
        latest: {
          id: resolved.editId,
          message_id: resolved.messageId,
          conversation_id: resolved.conversationId,
          editor_user_id: user?.id ?? '',
          revision: resolved.revision,
          encrypted_body: '',
          archive_body: null,
          edited_at: resolved.editedAt,
        },
        resolved,
      }));
      void queryClient.invalidateQueries({ queryKey: ['message-edit', resolved.messageId] });
    },
  });

  const canEdit = useMemo(
    () => active && canEditMessage(contextQuery.data?.meta, user?.id),
    [active, contextQuery.data?.meta, user?.id],
  );

  return {
    meta: contextQuery.data?.meta ?? null,
    latest: contextQuery.data?.latest ?? null,
    resolved: contextQuery.data?.resolved ?? null,
    canEdit,
    isLoading: contextQuery.isLoading,
    editMessage: mutation.mutateAsync,
    isSaving: mutation.isPending,
    error: mutation.error,
  };
}
