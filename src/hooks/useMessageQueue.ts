import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import {
  cancelAegisRetry,
  isRetryableOutboundStatus,
  scheduleAegisRetry,
} from '@/lib/messaging/aegisConversationQueue';
import {
  useAegisMessageQueue,
  selectInitialDeliveryMode,
  type OutboundMessage,
} from './useAegisMessageQueue';

export { selectInitialDeliveryMode };
export type { OutboundMessage } from './useAegisMessageQueue';

type SendExtra = {
  view_once?: boolean;
  document_url?: string | null;
  document_name?: string | null;
  document_mime?: string | null;
  document_size_bytes?: number | null;
};

/**
 * Stable message queue shared by the widget and full messenger surfaces.
 *
 * The public signature is kept for compatibility with the legacy Aegis reader,
 * but new outbound messages use the server transport. No identity, Signed
 * PreKey or device-route prewarm runs before Send.
 */
export function useMessageQueue(
  conversationId: string,
  _encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,
  isEncryptionReady: boolean,
  _isEncryptionActive: boolean,
  onMessageSent?: (localId: string) => void | Promise<void>,
  allowPlaintext = false,
  onPlaintextCached?: (serverId: string, plaintext: string) => void,
) {
  const { user } = useAuth();
  const scheduledRetryKeysRef = useRef(new Set<string>());

  const handleSent = useCallback(async (localId: string) => {
    await onMessageSent?.(localId);
  }, [onMessageSent]);

  const queue = useAegisMessageQueue(
    conversationId,
    null,
    isEncryptionReady,
    handleSent,
    allowPlaintext,
    async (serverId, plaintext) => {
      onPlaintextCached?.(serverId, plaintext);
    },
  );

  const retryMessage = queue.retryMessage;
  const markRetryExhausted = queue.markRetryExhausted;

  const scheduleRetryForMessage = useCallback((message: OutboundMessage, immediate = false) => {
    if (!user?.id) return;

    const retryKey = `${user.id}:${message.localId}`;
    if (!isRetryableOutboundStatus(message.status, message.lastError)) {
      cancelAegisRetry(retryKey);
      scheduledRetryKeysRef.current.delete(retryKey);
      return;
    }

    if (immediate) cancelAegisRetry(retryKey);
    scheduledRetryKeysRef.current.add(retryKey);
    const scheduled = scheduleAegisRetry(
      retryKey,
      async () => {
        await retryMessage(message.localId);
      },
      {
        immediate,
        onExhausted: () => {
          scheduledRetryKeysRef.current.delete(retryKey);
          void markRetryExhausted(message.localId);
        },
      },
    );

    if (!scheduled) {
      cancelAegisRetry(retryKey);
      scheduledRetryKeysRef.current.delete(retryKey);
    }
  }, [markRetryExhausted, retryMessage, user?.id]);

  // Restore and retry an interrupted stable-UUID commit. The RPC is
  // idempotent, so a response lost after database commit cannot duplicate it.
  useEffect(() => {
    const activeRetryKeys = new Set<string>();
    for (const message of queue.pendingMessages) {
      if (!user?.id || !isRetryableOutboundStatus(message.status, message.lastError)) continue;
      const retryKey = `${user.id}:${message.localId}`;
      activeRetryKeys.add(retryKey);
      scheduleRetryForMessage(message);
    }

    for (const retryKey of scheduledRetryKeysRef.current) {
      if (activeRetryKeys.has(retryKey)) continue;
      const stillPending = queue.pendingMessages.find(
        (message) => `${user?.id}:${message.localId}` === retryKey,
      );
      cancelAegisRetry(retryKey, {
        resetAttempts: !stillPending || stillPending.status === 'failed_visible',
      });
    }
    scheduledRetryKeysRef.current = activeRetryKeys;
  }, [queue.pendingMessages, scheduleRetryForMessage, user?.id]);

  // A real reconnect may immediately resume a pending commit. Focus alone no
  // longer starts device-route work or a second send storm.
  useEffect(() => {
    const retryNow = () => {
      for (const message of queue.pendingMessages) {
        if (isRetryableOutboundStatus(message.status, message.lastError)) {
          scheduleRetryForMessage(message, true);
        }
      }
    };

    window.addEventListener('online', retryNow);
    return () => window.removeEventListener('online', retryNow);
  }, [queue.pendingMessages, scheduleRetryForMessage]);

  useEffect(() => () => {
    for (const retryKey of scheduledRetryKeysRef.current) cancelAegisRetry(retryKey);
    scheduledRetryKeysRef.current.clear();
  }, [conversationId, user?.id]);

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
