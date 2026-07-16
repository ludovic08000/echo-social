import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { savePlaintext } from '@/lib/crypto/plaintextStore';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { listFanoutTargets } from '@/e2ee-session/deviceRegistry';
import { bubbleDiagnostic } from '@/lib/messaging/bubbleDiagnostics';
import {
  cancelSignalRetry,
  isRetryableOutboundStatus,
  runSignalConversationJob,
  scheduleSignalRetry,
} from '@/lib/messaging/signalWebConversationQueue';
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
  const scheduledRetryKeysRef = useRef(new Set<string>());
  const conversationQueueKey = `${user?.id ?? 'anonymous'}:${conversationId}`;

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

  /**
   * Signal-style warm send path.
   *
   * Signal creates a local outgoing message and durable job immediately, while
   * identities/device routes are normally already hot. Sesame keeps the same
   * trust gates, but primes the authenticated session, local E2EE identity and
   * canonical signed device lists before the user presses Send. No plaintext,
   * ciphertext or ratchet step is produced here.
   *
   * A short cooldown matches the verified-device RAM cache. Pointer/focus and
   * online events make the common "tap composer, type, send" path warm without
   * polling Supabase continuously in the background.
   */
  useEffect(() => {
    if (!user?.id || !conversationId || allowPlaintext || !isEncryptionActive) return;

    let cancelled = false;
    let lastStartedAt = 0;
    const cooldownMs = 8_000;

    const prewarm = () => {
      const now = Date.now();
      if (now - lastStartedAt < cooldownMs) return;
      lastStartedAt = now;

      void Promise.allSettled([
        supabase.auth.getSession(),
        ensureUserE2EEIdentity(user.id, { waitForMaintenance: false }),
        (async () => {
          const { data, error } = await supabase
            .from('conversation_participants')
            .select('user_id')
            .eq('conversation_id', conversationId);
          if (error || cancelled) return;

          const recipientUserIds = Array.from(new Set(
            (data ?? [])
              .map((row) => row.user_id)
              .filter((id): id is string => typeof id === 'string' && id.length > 0),
          ));

          // listFanoutTargets only returns routes from the canonical signed
          // device list. verifyPrekeys=false skips unnecessary SPK network work;
          // X3DH verifies a signed prekey if a fresh session is actually needed.
          await listFanoutTargets(user.id, recipientUserIds, { verifyPrekeys: false });
        })(),
      ]).catch(() => undefined);
    };

    prewarm();
    window.addEventListener('focus', prewarm);
    window.addEventListener('online', prewarm);
    window.addEventListener('pointerdown', prewarm, { passive: true });

    return () => {
      cancelled = true;
      window.removeEventListener('focus', prewarm);
      window.removeEventListener('online', prewarm);
      window.removeEventListener('pointerdown', prewarm);
    };
  }, [user?.id, conversationId, allowPlaintext, isEncryptionActive]);

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

  const scheduleRetryForMessage = useCallback((message: (typeof queue.pendingMessages)[number], immediate = false) => {
    if (!user?.id) return;

    const retryKey = `${user.id}:${message.localId}`;
    if (!isRetryableOutboundStatus(message.status, message.lastError)) {
      cancelSignalRetry(retryKey);
      scheduledRetryKeysRef.current.delete(retryKey);
      return;
    }

    if (immediate) cancelSignalRetry(retryKey);
    scheduledRetryKeysRef.current.add(retryKey);
    scheduleSignalRetry(
      retryKey,
      async () => {
        await runSignalConversationJob(conversationQueueKey, async () => {
          await queue.retryMessage(message.localId);
        });
      },
      { immediate },
    );
  }, [conversationQueueKey, queue.pendingMessages, queue.retryMessage, user?.id]);

  // Signal-style durable resume: rows restored from the encrypted IndexedDB
  // outbox are retried automatically instead of waiting for a manual tap.
  useEffect(() => {
    const activeRetryKeys = new Set<string>();
    for (const message of queue.pendingMessages) {
      if (!user?.id || !isRetryableOutboundStatus(message.status, message.lastError)) continue;
      const retryKey = `${user.id}:${message.localId}`;
      activeRetryKeys.add(retryKey);
      scheduleRetryForMessage(message);
    }

    for (const retryKey of scheduledRetryKeysRef.current) {
      if (!activeRetryKeys.has(retryKey)) cancelSignalRetry(retryKey);
    }
    scheduledRetryKeysRef.current = activeRetryKeys;
  }, [queue.pendingMessages, scheduleRetryForMessage, user?.id]);

  // A reconnect or foreground event should not wait for an existing backoff.
  useEffect(() => {
    const retryNow = () => {
      for (const message of queue.pendingMessages) {
        if (isRetryableOutboundStatus(message.status, message.lastError)) {
          scheduleRetryForMessage(message, true);
        }
      }
    };

    window.addEventListener('online', retryNow);
    window.addEventListener('focus', retryNow);
    return () => {
      window.removeEventListener('online', retryNow);
      window.removeEventListener('focus', retryNow);
    };
  }, [queue.pendingMessages, scheduleRetryForMessage]);

  useEffect(() => () => {
    for (const retryKey of scheduledRetryKeysRef.current) cancelSignalRetry(retryKey);
    scheduledRetryKeysRef.current.clear();
  }, [conversationId, user?.id]);

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

      // Signal Desktop processes normal messages through a per-conversation job
      // queue. Web Locks extends that guarantee across multiple browser tabs;
      // the in-memory fallback preserves it in browsers without Web Locks.
      await runSignalConversationJob(conversationQueueKey, async () => {
        await queue.sendMessage(body, imageUrl, extra);
      });
    }, [allowPlaintext, conversationId, conversationQueueKey, isEncryptionActive, isEncryptionReady, queue],
  );

  return {
    ...queue,
    sendMessage,
  };
}
