import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { sendAegisOutboundMessage } from '@/lib/messaging/aegisOutboundEngine';

const ZEUS_BOT_ID = '00000000-0000-0000-0000-000000000001';

async function assertRegularMessengerConversation(conversationId: string): Promise<void> {
  const [conversationResult, zeusParticipantResult] = await Promise.all([
    supabase
      .from('conversations')
      .select('created_by')
      .eq('id', conversationId)
      .maybeSingle(),
    supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .eq('user_id', ZEUS_BOT_ID)
      .maybeSingle(),
  ]);

  if (conversationResult.error) throw conversationResult.error;
  if (zeusParticipantResult.error) throw zeusParticipantResult.error;
  if (!conversationResult.data) throw new Error('Conversation introuvable.');

  if (
    conversationResult.data.created_by === ZEUS_BOT_ID
    || zeusParticipantResult.data?.user_id === ZEUS_BOT_ID
  ) {
    throw new Error("Zeus est disponible uniquement dans l’espace IA dédié.");
  }
}

/**
 * The regular messenger has exactly one outbound transport: Aegis E2EE.
 * Zeus conversations belong to the dedicated AI surface and are rejected
 * before encryption or optimistic persistence is attempted. The database
 * trigger remains the final fail-closed boundary for historical blocked shells.
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

      await assertRegularMessengerConversation(conversationId);

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
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['messages', variables.conversationId] });
      if (user?.id) {
        void queryClient.invalidateQueries({ queryKey: ['conversations', user.id], exact: true });
      }
    },
  });
}
