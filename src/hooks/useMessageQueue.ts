import { useCallback, useEffect } from 'react';
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

  const sendMessage = useCallback(
    async (body: string, imageUrl?: string | null, extra?: SendExtra) => {
      await queue.sendMessage(body, imageUrl, extra);
    },
    [queue],
  );

  return {
    ...queue,
    sendMessage,
  };
}
