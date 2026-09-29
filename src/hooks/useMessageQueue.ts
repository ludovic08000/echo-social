import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import {
  cancelAegisRetry,
  isRetryableOutboundStatus,
  scheduleAegisRetry,
} from '@/lib/messaging/aegisConversationQueue';
import { traceE2EEBlock } from '@/lib/messaging/e2eeTrace';
import { warmFanoutRoute } from '@/lib/messaging/fanoutRouteCache';
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

// Keep this below the canonical route cache TTL (20 s). Composer focus/input
// can therefore refresh a route before Send without polling in the background.
const PREWARM_TTL_MS = 15_000;
const PREWARM_RETRY_MS = 2_000;
const prewarmCompletedAt = new Map<string, number>();
const prewarmAttemptedAt = new Map<string, number>();
const prewarmInflight = new Map<string, Promise<void>>();
let sessionPrewarmInflight: Promise<void> | null = null;

function prewarmSession(): Promise<void> {
  if (sessionPrewarmInflight) return sessionPrewarmInflight;
  const work = supabase.auth.getSession()
    .then(({ error }) => {
      if (error) throw error;
    })
    .finally(() => {
      if (sessionPrewarmInflight === work) sessionPrewarmInflight = null;
    });
  sessionPrewarmInflight = work;
  return work;
}

/**
 * Warms only authenticated, stable-device and public route metadata. It never
 * claims a prekey, creates ciphertext or advances a Libsignal ratchet.
 */
export function prewarmAegisSendPath(
  userId: string,
  conversationId: string,
): Promise<void> {
  if (!userId || !conversationId) return Promise.resolve();
  const prewarmKey = `${userId}:${conversationId}`;
  const lastCompletedAt = prewarmCompletedAt.get(prewarmKey) ?? 0;
  if (Date.now() - lastCompletedAt < PREWARM_TTL_MS) return Promise.resolve();

  const active = prewarmInflight.get(prewarmKey);
  if (active) return active;
  const lastAttemptedAt = prewarmAttemptedAt.get(prewarmKey) ?? 0;
  if (Date.now() - lastAttemptedAt < PREWARM_RETRY_MS) return Promise.resolve();
  prewarmAttemptedAt.set(prewarmKey, Date.now());

  const block = <T>(stage: string, operation: () => Promise<T>) => traceE2EEBlock({
    direction: 'send',
    component: 'send_prewarm',
    stage,
    conversationId,
  }, operation);

  const task = (async () => {
    const [session, device] = await Promise.allSettled([
      block('PREWARM_SESSION', prewarmSession),
      block('PREWARM_DEVICE', () => ensureAegisDeviceReady(userId)),
    ]);
    if (session.status !== 'fulfilled' || device.status !== 'fulfilled') return;

    await block('PREWARM_ROUTE', () => warmFanoutRoute(conversationId, userId));
    prewarmCompletedAt.set(prewarmKey, Date.now());
  })().finally(() => {
    if (prewarmInflight.get(prewarmKey) === task) prewarmInflight.delete(prewarmKey);
  });

  prewarmInflight.set(prewarmKey, task);
  return task;
}

export const __prewarmTest = {
  ttlMs: PREWARM_TTL_MS,
  retryMs: PREWARM_RETRY_MS,
  reset(): void {
    prewarmCompletedAt.clear();
    prewarmAttemptedAt.clear();
    prewarmInflight.clear();
    sessionPrewarmInflight = null;
  },
};

export function useMessageQueue(
  conversationId: string,
  isEncryptionActive: boolean,
  onMessageSent?: (localId: string) => void | Promise<void>,
  allowPlaintext = false,
  onPlaintextCached?: (serverId: string, plaintext: string) => void,
) {
  const { user } = useAuth();
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

    const prewarm = () => {
      if (document.visibilityState === 'hidden') return;
      void prewarmAegisSendPath(user.id, conversationId).catch(() => undefined);
    };

    prewarm();
    window.addEventListener('focus', prewarm);
    window.addEventListener('online', prewarm);

    return () => {
      window.removeEventListener('focus', prewarm);
      window.removeEventListener('online', prewarm);
    };
  }, [user?.id, conversationId, allowPlaintext, isEncryptionActive]);

  const handleSent = useCallback(async (localId: string) => {
    await onMessageSent?.(localId);
  }, [onMessageSent]);

  const queue = useAegisMessageQueue(
    conversationId,
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

  const sendMessage = useCallback(
    async (body: string, imageUrl?: string | null, extra?: SendExtra) => {
      // Do not lock the whole send. The underlying hook immediately creates the
      // optimistic bubble and persists the durable job, then queuedEncrypt
      // serializes only the ratchet state transition.
      if (user?.id && !allowPlaintext && isEncryptionActive) {
        // Starting this without awaiting it lets the canonical fanout resolver
        // share the same in-flight route while the durable outbox is written.
        void prewarmAegisSendPath(user.id, conversationId).catch(() => undefined);
      }
      await queue.sendMessage(body, imageUrl, extra);
    }, [allowPlaintext, conversationId, isEncryptionActive, queue, user?.id],
  );

  const prewarmSendPath = useCallback(() => {
    if (!user?.id || allowPlaintext || !isEncryptionActive) return Promise.resolve();
    return prewarmAegisSendPath(user.id, conversationId);
  }, [allowPlaintext, conversationId, isEncryptionActive, user?.id]);

  return {
    ...queue,
    sendMessage,
    prewarmSendPath,
  };
}
