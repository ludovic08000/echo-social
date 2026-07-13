import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { savePlaintext } from '@/lib/crypto/plaintextStore';
import { bubbleDiagnostic } from '@/lib/messaging/bubbleDiagnostics';
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
  const previousPendingRef = useRef(new Map<string, { status: string; serverId: string | null }>());

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
    const previous = previousPendingRef.current.get(localId);
    bubbleDiagnostic('OUTBOX_DELETE', {
      conversationId,
      localId,
      serverId: previous?.serverId ?? null,
      reason: 'on_message_sent_ack',
      details: {
        previousStatus: previous?.status ?? null,
      },
    });
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
      bubbleDiagnostic('REALTIME_EVENT', {
        conversationId,
        serverId,
        reason: 'plaintext_cached_for_server_message',
        details: {
          textLength: plaintext.length,
        },
      });
      onPlaintextCached?.(serverId, plaintext);
      await savePlaintext(serverId, plaintext);
    },
  );

  useEffect(() => {
    const previous = previousPendingRef.current;
    const current = new Map<string, { status: string; serverId: string | null }>();

    for (const message of queue.pendingMessages) {
      current.set(message.localId, {
        status: message.status,
        serverId: message.serverId,
      });
      const before = previous.get(message.localId);
      if (!before) {
        bubbleDiagnostic('OUTBOX_RESTORE', {
          conversationId,
          localId: message.localId,
          serverId: message.serverId,
          traceId: message.traceId,
          reason: message.retryCount > 0 || message.status === 'retry_pending'
            ? 'pending_message_restored_or_retried'
            : 'pending_message_entered_queue',
          details: {
            status: message.status,
            retryCount: message.retryCount,
            maxRetries: message.maxRetries,
            hasEncryptedBody: Boolean(message.encryptedBody),
            hasMedia: Boolean(message.imageUrl),
            ageMs: Date.now() - message.createdAt,
          },
        });
      } else if (before.status !== message.status || before.serverId !== message.serverId) {
        bubbleDiagnostic('OUTBOX_PUT', {
          conversationId,
          localId: message.localId,
          serverId: message.serverId,
          traceId: message.traceId,
          reason: 'pending_message_state_changed',
          details: {
            previousStatus: before.status,
            nextStatus: message.status,
            previousServerId: before.serverId,
            nextServerId: message.serverId,
            retryCount: message.retryCount,
            hasEncryptedBody: Boolean(message.encryptedBody),
          },
        });
      }
    }

    for (const [localId, before] of previous) {
      if (!current.has(localId)) {
        bubbleDiagnostic('OUTBOX_DELETE', {
          conversationId,
          localId,
          serverId: before.serverId,
          reason: 'pending_message_left_queue',
          details: {
            previousStatus: before.status,
          },
        });
      }
    }

    previousPendingRef.current = current;
  }, [conversationId, queue.pendingMessages]);

  const sendMessage = useCallback(
    async (body: string, imageUrl?: string | null, extra?: SendExtra) => {
      bubbleDiagnostic('OUTBOX_PUT', {
        conversationId,
        reason: 'send_requested',
        details: {
          textLength: body.length,
          hasMedia: Boolean(imageUrl),
          viewOnce: Boolean(extra?.view_once),
          hasDocument: Boolean(extra?.document_url),
          encryptionActive: isEncryptionActive,
          encryptionReady: isEncryptionReady,
          allowPlaintext,
        },
      });
      await queue.sendMessage(body, imageUrl, extra);
    }, [allowPlaintext, conversationId, isEncryptionActive, isEncryptionReady, queue]);

  return {
    ...queue,
    sendMessage,
  };
}
