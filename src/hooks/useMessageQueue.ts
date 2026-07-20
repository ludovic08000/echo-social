import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { listFanoutTargets } from '@/e2ee-session/deviceRegistry';
import { bubbleDiagnostic } from '@/lib/messaging/bubbleDiagnostics';
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

const PREWARM_TTL_MS = 60_000;
const prewarmCompletedAt = new Map<string, number>();
const prewarmInflight = new Map<string, Promise<void>>();

export function useMessageQueue(
  conversationId: string,
  _encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,
  isEncryptionReady: boolean,
  isEncryptionActive: boolean,
  onMessageSent?: (localId: string) => void | Promise<void>,
  allowPlaintext = false,
  onPlaintextCached?: (serverId: string, plaintext: string) => void,
) {
  const { user } = useAuth();
  const previousPendingRef = useRef(new Map<string, { status: string; serverId: string | null }>());
  const scheduledRetryKeysRef = useRef(new Set<string>());

  /**
   * Aegis warm send path.
   *
   * Aegis creates a local outgoing message and durable job immediately while
   * priming the authenticated session, local E2EE identity and canonical
   * device routes before Send. The warmup never creates ciphertext or advances
   * a Ratchet.
   */
  useEffect(() => {
    if (!user?.id || !conversationId || allowPlaintext || !isEncryptionActive) return;

    let cancelled = false;
    const prewarmKey = `${user.id}:${conversationId}`;

    const prewarm = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      const lastCompletedAt = prewarmCompletedAt.get(prewarmKey) ?? 0;
      if (Date.now() - lastCompletedAt < PREWARM_TTL_MS) return;
      if (prewarmInflight.has(prewarmKey)) return;

      const task = (async () => {
        await Promise.allSettled([
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

            await listFanoutTargets(user.id, recipientUserIds, { verifyPrekeys: false });
          })(),
        ]);
        if (!cancelled) prewarmCompletedAt.set(prewarmKey, Date.now());
      })().finally(() => {
        if (prewarmInflight.get(prewarmKey) === task) prewarmInflight.delete(prewarmKey);
      });

      prewarmInflight.set(prewarmKey, task);
    };

    prewarm();
    window.addEventListener('focus', prewarm);
    window.addEventListener('online', prewarm);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', prewarm);
      window.removeEventListener('online', prewarm);
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

  const queue = useAegisMessageQueue(
    conversationId,
    null,
    isEncryptionReady,
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

  // Aegis durable resume: rows restored from the encrypted IndexedDB
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
      if (activeRetryKeys.has(retryKey)) continue;
      const stillPending = queue.pendingMessages.find(
        (message) => `${user?.id}:${message.localId}` === retryKey,
      );
      // A retry task temporarily moves through encrypting/sending. Preserve
      // its attempt counter or every failure restarts at 500 ms forever.
      cancelAegisRetry(retryKey, {
        resetAttempts: !stillPending || stillPending.status === 'failed_visible',
      });
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
    window.addEventListener('forsure:aegis-route-ready', retryNow);
    return () => {
      window.removeEventListener('online', retryNow);
      window.removeEventListener('focus', retryNow);
      window.removeEventListener('forsure:aegis-route-ready', retryNow);
    };
  }, [queue.pendingMessages, scheduleRetryForMessage]);

  useEffect(() => () => {
    for (const retryKey of scheduledRetryKeysRef.current) cancelAegisRetry(retryKey);
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

      // Do not lock the whole send. The underlying hook immediately creates the
      // optimistic bubble and persists the durable job, then queuedEncrypt
      // serializes only the ratchet state transition.
      await queue.sendMessage(body, imageUrl, extra);
    }, [allowPlaintext, conversationId, isEncryptionActive, isEncryptionReady, queue],
  );

  return {
    ...queue,
    sendMessage,
  };
}
