import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { sendAegisOutboundMessage } from '@/lib/messaging/aegisOutboundEngine';
import type { Message } from './useMessages.legacy';

const ZEUS_BOT_ID = '00000000-0000-0000-0000-000000000001';

const messagesKey = (conversationId: string, userId: string | undefined) =>
  ['messages', conversationId, userId ?? 'anon'] as const;

/**
 * The regular messenger has exactly one outbound transport: Aegis E2EE.
 * Zeus conversations belong to the dedicated AI surface and are rejected
 * before encryption or optimistic persistence is attempted.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ conversationId, body, imageUrl }: {
      conversationId: string;
      body: string;
      imageUrl?: string;
    }) => {
      if (!user) throw new Error('Not authenticated');

      const { data: conversation, error: conversationError } = await supabase
        .from('conversations')
        .select('created_by')
        .eq('id', conversationId)
        .maybeSingle();

      if (conversationError) throw conversationError;
      if (conversation?.created_by === ZEUS_BOT_ID) {
        throw new Error("Zeus est disponible uniquement dans l’espace IA dédié.");
      }

      const isSpecialMessage = body.startsWith('🎙️ voice:') || body === '📷 Image';
      if (!isSpecialMessage) {
        const validation = validateMessage(body);
        if (!validation.valid) throw new Error(validation.error);
      }

      const sanitizedBody = isSpecialMessage ? body : sanitizeMessageBody(body);

      let sent: Awaited<ReturnType<typeof sendAegisOutboundMessage>>;
      try {
        sent = await sendAegisOutboundMessage({
          conversationId,
          senderUserId: user.id,
          plaintext: sanitizedBody,
          imageUrl: imageUrl ?? null,
        });
      } catch {
        throw new Error('Message non envoyé — chiffrement non disponible.');
      }

      if (!isSpecialMessage) recordSentMessage(sanitizedBody);

      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId);

      void queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', user.id], exact: true });

      return {
        id: sent.id,
        conversation_id: conversationId,
        sender_id: user.id,
        body: sent.parentBody,
      };
    },
    onMutate: async (variables) => {
      if (!user) return;

      const key = messagesKey(variables.conversationId, user.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previousMessages = queryClient.getQueryData<Message[]>(key);
      const profile = queryClient.getQueryData<{ name?: string; avatar_url?: string | null }>([
        'profile',
        user.id,
      ]);

      const optimisticMessage: Message = {
        id: `optimistic-${Date.now()}`,
        conversation_id: variables.conversationId,
        sender_id: user.id,
        body: variables.body,
        image_url: variables.imageUrl || null,
        created_at: new Date().toISOString(),
        status: 'delivered',
        profile: {
          name: profile?.name || user.user_metadata?.name || 'Moi',
          avatar_url: profile?.avatar_url || null,
        },
      };

      queryClient.setQueryData<Message[]>(key, (old) => [...(old || []), optimisticMessage]);
      return { previousMessages };
    },
    onError: (_error, variables, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData(
          messagesKey(variables.conversationId, user?.id),
          context.previousMessages,
        );
      }
    },
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['messages', variables.conversationId] });
      if (user?.id) {
        void queryClient.invalidateQueries({ queryKey: ['conversations', user.id], exact: true });
      }
    },
  });
}
