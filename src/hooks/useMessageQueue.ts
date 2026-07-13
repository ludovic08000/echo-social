import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { savePlaintext } from '@/lib/crypto/plaintextStore';
import {
  recoverRecentMessagesAfterUnlock,
  installRecoverRecentMessagesListeners,
} from '@/lib/crypto/recoverRecentMessagesAfterUnlock';
import {
  useMessageQueue as useSignalMessageQueue,
  shouldArchiveMessageBody,
  buildMultiDeviceParentEnvelope,
  type OutboundMessage,
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

const MAX_STORED_CONVERSATIONS = 20;
const MAX_PENDING_PER_CONVERSATION = 50;
const pendingByConversation = new Map<string, OutboundMessage[]>();

function writePending(conversationId: string, messages: OutboundMessage[]): void {
  if (!conversationId) return;
  const bounded = messages.slice(-MAX_PENDING_PER_CONVERSATION);
  pendingByConversation.delete(conversationId);
  if (bounded.length > 0) pendingByConversation.set(conversationId, bounded);

  while (pendingByConversation.size > MAX_STORED_CONVERSATIONS) {
    const oldest = pendingByConversation.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingByConversation.delete(oldest);
  }
}

function removeStoredPending(conversationId: string, localId: string): void {
  const current = pendingByConversation.get(conversationId) ?? [];
  writePending(conversationId, current.filter((message) => message.localId !== localId));
}

function mergePending(
  stored: OutboundMessage[],
  live: OutboundMessage[],
): OutboundMessage[] {
  const byId = new Map<string, OutboundMessage>();
  stored.forEach((message) => byId.set(message.localId, message));
  live.forEach((message) => byId.set(message.localId, message));
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
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
  const previousConversationRef = useRef(conversationId);
  const latestLivePendingRef = useRef<OutboundMessage[]>([]);

  useEffect(() => {
    if (!user?.id || allowPlaintext || !isEncryptionActive) return;

    const stop = installRecoverRecentMessagesListeners(user.id);
    const timer = window.setTimeout(() => {
      void recoverRecentMessagesAfterUnlock(user.id, 'message-queue-mounted').catch(() => undefined);
    }, 250);

    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [user?.id, allowPlaintext, isEncryptionActive]);

  const handleSent = useCallback(async (localId: string) => {
    removeStoredPending(conversationId, localId);
    await onMessageSent?.(localId);
  }, [conversationId, onMessageSent]);

  const queue = useSignalMessageQueue(
    conversationId,
    encrypt,
    isEncryptionReady,
    isEncryptionActive,
    handleSent,
    allowPlaintext,
    async (serverId, plaintext) => {
      onPlaintextCached?.(serverId, plaintext);
      await savePlaintext(serverId, plaintext);
    },
  );

  const liveForConversation = queue.pendingMessages.filter(
    (message) => message.conversationId === conversationId,
  );
  latestLivePendingRef.current = liveForConversation;

  if (previousConversationRef.current !== conversationId) {
    const previousId = previousConversationRef.current;
    const previousLive = latestLivePendingRef.current.filter(
      (message) => message.conversationId === previousId,
    );
    if (previousLive.length > 0) writePending(previousId, previousLive);
    previousConversationRef.current = conversationId;
  }

  useEffect(() => {
    if (liveForConversation.length > 0) {
      writePending(conversationId, liveForConversation);
    }
  }, [conversationId, liveForConversation]);

  const pendingMessages = useMemo(
    () => mergePending(pendingByConversation.get(conversationId) ?? [], liveForConversation),
    [conversationId, liveForConversation],
  );

  const sendMessage = useCallback(
    async (body: string, imageUrl?: string | null, extra?: SendExtra) => {
      // The signal queue owns encryption and exact server-id persistence. This
      // wrapper only preserves the local bubble while navigation remounts chat.
      await queue.sendMessage(body, imageUrl, extra);
    },
    [queue],
  );

  const removeMessage = useCallback(async (localId: string) => {
    removeStoredPending(conversationId, localId);
    await queue.removeMessage(localId);
  }, [conversationId, queue]);

  return {
    ...queue,
    pendingMessages,
    sendMessage,
    removeMessage,
  };
}
