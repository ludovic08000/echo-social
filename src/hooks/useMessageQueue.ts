import { useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import {
  recoverRecentMessagesAfterUnlock,
  installRecoverRecentMessagesListeners,
} from '@/lib/crypto/recoverRecentMessagesAfterUnlock';
import {
  useMessageQueue as useSignalMessageQueue,
  shouldArchiveMessageBody,
  buildMultiDeviceParentEnvelope,
} from './useMessageQueueSignal';

export { shouldArchiveMessageBody, buildMultiDeviceParentEnvelope };
export type { OutboundMessage } from './useMessageQueueSignal';

type SendExtra = {
  view_once?: boolean;
  document_url?: string | null;
  document_name?: string | null;
  document_mime?: string | null;
  document_size_bytes?: number | null;
};

function inferPlaintextBody(body: string, imageUrl?: string | null): string {
  const trimmed = body.trim();
  if (trimmed) return body;
  if (!imageUrl) return '';
  const lower = imageUrl.toLowerCase().split('?')[0];
  if (lower.endsWith('.gif') || lower.includes('image/gif')) return '🎞️ GIF';
  if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.includes('video')) return '🎬 Vidéo';
  return '📷 Photo';
}

function looksLikeEncryptedServerBody(body: string, plaintext: string): boolean {
  if (!body || body === plaintext) return false;
  if (body.startsWith('sk1.') || body.startsWith('x3dh') || body.startsWith('x3dh5')) return true;
  try {
    const parsed = JSON.parse(body);
    return Boolean(
      parsed?.fs_secure_pipeline ||
      parsed?.encryptionMode ||
      parsed?.ct ||
      parsed?.hdr ||
      parsed?.body
    );
  } catch {
    return false;
  }
}

export function useMessageQueue(
  conversationId: string,
  encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,
  isEncryptionReady: boolean,
  isEncryptionActive: boolean,
  onMessageSent?: (localId: string) => void | Promise<void>,
  allowPlaintext = false,
  onPlaintextCached?: (serverId: string, plaintext: string) => void,
) {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id || allowPlaintext || !isEncryptionActive) return;

    const stop = installRecoverRecentMessagesListeners(user.id);

    // Conversation mount / return path: if PIN already restored the keys before
    // this hook mounted, run a small recovery pass now so encrypted server rows
    // are re-linked to plaintext before the user sees empty bubbles.
    const timer = window.setTimeout(() => {
      void recoverRecentMessagesAfterUnlock(user.id, 'message-queue-mounted').catch(() => undefined);
    }, 250);

    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [user?.id, allowPlaintext, isEncryptionActive]);

  const queue = useSignalMessageQueue(
    conversationId,
    encrypt,
    isEncryptionReady,
    isEncryptionActive,
    onMessageSent,
    allowPlaintext,
    async (serverId, plaintext) => {
      onPlaintextCached?.(serverId, plaintext);
      await savePlaintext(serverId, plaintext);
    },
  );

  const sendMessage = useCallback(async (body: string, imageUrl?: string | null, extra?: SendExtra) => {
    const plaintext = inferPlaintextBody(body, imageUrl);
    const sentAfter = new Date(Date.now() - 5_000).toISOString();

    await queue.sendMessage(body, imageUrl, extra);

    if (!user?.id || !plaintext.trim() || allowPlaintext || !isEncryptionActive) return;

    // Best-effort durability fix: the UI first shows the optimistic plaintext,
    // then React Query replaces it with the encrypted server body. Persist the
    // same plaintext under both the server message id and the ciphertext hash so
    // DecryptedMessageBody can recover it after refetch/remount/reload.
    window.setTimeout(() => {
      void (async () => {
        try {
          const { data } = await supabase
            .from('messages')
            .select('id, body, created_at')
            .eq('conversation_id', conversationId)
            .eq('sender_id', user.id)
            .gte('created_at', sentAfter)
            .order('created_at', { ascending: false })
            .limit(5);

          const row = (data || []).find((message: any) =>
            typeof message?.id === 'string' &&
            typeof message?.body === 'string' &&
            looksLikeEncryptedServerBody(message.body, plaintext)
          );

          if (!row) return;
          await savePlaintext(row.id, plaintext);
          await savePlaintextForCiphertext(row.body, plaintext);
          try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch {}
        } catch {
          // Non-blocking cache repair only. The encrypted send itself already succeeded.
        }
      })();
    }, 250);
  }, [queue, conversationId, user?.id, allowPlaintext, isEncryptionActive]);

  return {
    ...queue,
    sendMessage,
  };
}
