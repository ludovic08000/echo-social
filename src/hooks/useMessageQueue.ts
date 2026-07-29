import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import {
  cancelAegisRetry,
  isRetryableOutboundStatus,
  scheduleAegisRetry,
} from '@/lib/messaging/aegisConversationQueue';
import { selectInitialDeliveryMode } from './useAegisMessageQueue';
import {
  useServerMessageQueue,
  type OutboundMessage,
} from './useServerMessageQueue';

// Kept only for older unit tests/imports while historical Aegis rows remain.
export { selectInitialDeliveryMode };
export type { OutboundMessage } from './useServerMessageQueue';

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
 * The public signature remains compatible with older callers, but runtime
 * delivery is now a stable-UUID server transaction. Encryption readiness,
 * peer keys and device routes are intentionally ignored for new messages.
 */
export function useMessageQueue(
  conversationId: string,
  _encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,
  _isEncryptionReady: boolean,
  _hasLegacyEncryptedHistory: boolean,
  _onMessageSent?: (localId: string) => void | Promise<void>,
  _allowPlaintext = false,
  onPlaintextCached?: (serverId: string, plaintext: string) => void,
) {
  const { user } = useAuth();
  const scheduledRetryKeysRef = useRef(new Set<string>());
  const queue = useServerMessageQueue(conversationId, onPlaintextCached);

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

  // Only a real network reconnect starts an immediate retry. Focus and PIN
  // events never create a duplicate send storm.
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
