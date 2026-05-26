/**
 * useMessageQueue — React hook for the persistent local message queue.
 *
 * Security model (v5 — strict):
 * - For E2EE conversations: messages are ALWAYS queued and encrypted before send.
 *   No plaintext ever leaves the device. If E2EE is not ready, the queue keeps
 *   retrying with backoff until keys are available — the user sees the message
 *   as "pending" but it is NEVER sent in clear.
 * - For Zeus conversations only (`allowPlaintext = true`): the message is
 *   inserted directly because Zeus is a server-side bot, not a peer.
 * - Plaintext is held only in volatile memory (Map ref) — never persisted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { messageQueue, type OutboundMessage } from '@/lib/messaging/messageQueue';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { fanoutMessageCopies } from '@/lib/messaging/multiDeviceFanout';
import { processDeviceCopyRetryRequests } from '@/lib/messaging/deviceCopyRetryProcessor';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { safeUUID } from '@/e2ee-session';
import { isOutboundEncryptedBody } from '@/lib/messaging/messageCompatibility';

export function useMessageQueue(
  conversationId: string,
  encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,
  isEncryptionReady: boolean,
  isEncryptionActive: boolean,
  onMessageSent?: (localId: string) => void | Promise<void>,
  /** ONLY enable for Zeus (server bot). Never for peer conversations. */
  allowPlaintext = false,
  onPlaintextCached?: (serverId: string, plaintext: string) => void,
) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [rawPendingMessages, setRawPendingMessages] = useState<OutboundMessage[]>([]);
  // Volatile plaintext cache — never persisted, survives only in memory
  const plaintextCacheRef = useRef<Map<string, string>>(new Map());
  const handlerIdRef = useRef(safeUUID());
  const encryptRef = useRef(encrypt);
  const readyRef = useRef(isEncryptionReady);
  const activeRef = useRef(isEncryptionActive);

  // Keep refs fresh
  encryptRef.current = encrypt;
  readyRef.current = isEncryptionReady;
  activeRef.current = isEncryptionActive;

  // Register handlers with the queue (for queued messages that need retry)
  useEffect(() => {
    if (!user || !conversationId) return;

    messageQueue.registerHandlers(conversationId, handlerIdRef.current, {
      encrypt: async (plaintext: string, _convId: string, localId: string) => {
        if (!activeRef.current) {
          logCryptoError({
            severity: 'warning',
            context: 'queue.encrypt',
            errorCode: 'E_NOT_ACTIVE',
            errorMessage: 'Encryption not active when queue tried to encrypt',
            conversationId: _convId,
            metadata: { localId },
          });
          throw new Error('Encryption not active');
        }
        if (!encryptRef.current) {
          logCryptoError({
            severity: 'warning',
            context: 'queue.encrypt',
            errorCode: 'E_INITIALIZING',
            errorMessage: 'Encrypt handler not yet wired (E2EE initializing)',
            conversationId: _convId,
            metadata: { localId },
          });
          throw new Error('Encryption initializing');
        }
        try {
          return await encryptRef.current(plaintext, localId);
        } catch (e) {
          logCryptoException('queue.encrypt', e, {
            conversationId: _convId,
            metadata: { localId },
          });
          throw e;
        }
      },
      send: async (msg: OutboundMessage) => {
        if (!msg.encryptedBody) {
          throw new Error('Message not encrypted');
        }
        if (!isOutboundEncryptedBody(msg.encryptedBody)) {
          logCryptoError({
            severity: 'error',
            context: 'queue.send',
            errorCode: 'E_INSERT_BODY_INVALID',
            errorMessage: 'Blocked invalid encrypted body before messages insert',
            conversationId: msg.conversationId,
            metadata: { localId: msg.localId, traceId: msg.traceId },
          });
          throw new Error('Encrypted body invalid - database insert blocked');
        }

        // SECURITY: Drop orphan messages from a previous user session.
        // IndexedDB persists across logout/login; if senderId no longer matches
        // the current authenticated user, RLS will return 403 forever.
        if (!user || msg.senderId !== user.id) {
          console.warn('[MSG] Dropping orphan queued message from previous session', {
            localId: msg.localId,
            queuedSender: msg.senderId,
            currentUser: user?.id ?? null,
          });
          await messageQueue.removeMessage(msg.localId);
          return msg.serverId ?? safeUUID();
        }

        const outboundId = msg.serverId ?? safeUUID();
        msg.serverId = outboundId;

        const { error } = await supabase
          .from('messages')
          .insert({
            id: outboundId,
            conversation_id: msg.conversationId,
            sender_id: msg.senderId,
            body: msg.encryptedBody,
            image_url: msg.imageUrl,
          });

        if (error?.code === '23505') {
          // Cache plaintext for own message display
          if (msg.plaintext) onPlaintextCached?.(outboundId, msg.plaintext);
          await onMessageSent?.(msg.localId);
          return outboundId;
        }
        if (error) {
          logCryptoError({
            severity: 'error',
            context: 'queue.send',
            errorCode: 'E_INSERT',
            errorMessage: error.message,
            conversationId: msg.conversationId,
            metadata: { localId: msg.localId, traceId: msg.traceId, code: error.code },
          });
          throw error;
        }

        // Cache plaintext so sender sees cleartext (ratchet can't decrypt own messages)
        if (msg.plaintext) onPlaintextCached?.(outboundId, msg.plaintext);

        // Multi-device fan-out (additive — failure is non-fatal).
        // Distributes per-device copies so the recipient's other devices and
        // the sender's other devices can read the message. The primary
        // recipient device still relies on the per-conversation Double Ratchet.
        if (msg.plaintext) {
          try {
            const fanout = await fanoutMessageCopies({
              messageId: outboundId,
              conversationId: msg.conversationId,
              senderUserId: msg.senderId,
              plaintext: msg.plaintext,
            });
            if (fanout.multiDevice && fanout.failed > 0) {
              logCryptoError({
                severity: 'warning',
                context: 'fanout',
                errorCode: 'E_FANOUT_PARTIAL',
                errorMessage: 'Message sent, but not every active device received a copy',
                conversationId: msg.conversationId,
                metadata: {
                  localId: msg.localId,
                  serverId: outboundId,
                  targeted: fanout.targeted,
                  inserted: fanout.inserted,
                  failed: fanout.failed,
                },
              });
            }
          } catch (err) {
            logCryptoException('fanout', err, {
              severity: 'warning',
              conversationId: msg.conversationId,
              metadata: { localId: msg.localId, serverId: outboundId },
            });
          }
          void processDeviceCopyRetryRequests().catch(() => {});
        }

        await supabase
          .from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', msg.conversationId);

        await onMessageSent?.(msg.localId);
        queryClient.invalidateQueries({ queryKey: ['messages', msg.conversationId] });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });

        return outboundId;
      },
      isReady: (_convId: string) => {
        // CRITICAL: also verify encrypt handler is wired — on iOS the
        // `encrypted` flag can flip true a few ticks before `encrypt` is
        // assigned, causing a tight E_NOT_ACTIVE retry loop.
        return readyRef.current && activeRef.current && !!encryptRef.current;
      },
    });

    messageQueue.resumeForConversation(conversationId);

    return () => {
      messageQueue.unregisterHandlers(conversationId, handlerIdRef.current);
    };
  }, [user, conversationId, queryClient]);

  // Resume pending messages when encryption becomes ready
  useEffect(() => {
    if (isEncryptionReady && isEncryptionActive && conversationId) {
      messageQueue.resumeForConversation(conversationId);
    }
  }, [isEncryptionReady, isEncryptionActive, conversationId]);

  // Subscribe to queue updates + auto-cleanup old stuck messages
  useEffect(() => {
    const unsub = messageQueue.subscribe((msgs) => {
      const forConv = msgs.filter(m => m.conversationId === conversationId);
      setRawPendingMessages(forConv);
    });

    // Do not auto-delete waiting messages on mount. iOS/Safari can suspend a
    // tab long enough to make a healthy secure-channel wait look stuck.
    messageQueue.getPendingMessages(conversationId).then(async (msgs) => {
      setRawPendingMessages(msgs);
      messageQueue.resumeForConversation(conversationId);
    });

    return unsub;
  }, [conversationId]);

  // Resume on network restore
  useEffect(() => {
    const handler = () => {
      if (navigator.onLine) messageQueue.resumeForConversation(conversationId);
    };
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, [conversationId]);

  // Resume on page visibility
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') messageQueue.resumeForConversation(conversationId);
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [conversationId]);

  /**
   * Send a message:
   * - If E2EE ready → encrypt + send directly (instant)
   * - If E2EE active but not ready → queue for retry (message stays encrypted when sent)
   * - If not encrypted (Zeus) → send plaintext directly
   */
  const sendMessage = useCallback(async (body: string, imageUrl?: string | null) => {
    if (!user || !body.trim()) return;

    // Defense in depth: re-check the live auth session matches the hook's user.
    // Prevents queued messages from being sent under a different account after
    // a token refresh / silent re-auth.
    const { data: sess } = await supabase.auth.getSession();
    const liveUserId = sess.session?.user?.id;
    if (!liveUserId || liveUserId !== user.id) {
      throw new Error('🔒 Session expirée — reconnectez-vous pour envoyer.');
    }

    // Special messages bypass anti-spam: voice, plain photo/video labels,
    // and E2EE media bodies that embed a per-file key (label\x00MKEY:<base64>).
    const isMediaWithKey = body.includes('\x00MKEY:');
    const isSpecial =
      body.startsWith('🎙️ voice:') ||
      body === '📷 Photo' ||
      body === '🎬 Vidéo' ||
      isMediaWithKey;
    if (!isSpecial) {
      const validation = validateMessage(body);
      if (!validation.valid) throw new Error(validation.error);
    }

    const sanitized = isSpecial ? body : sanitizeMessageBody(body);

    // Case A — Zeus (server bot, no peer): plaintext is allowed by design.
    // For peer conversations where E2EE is still initializing, we DO NOT block:
    // we fall through to the queue (Case B), which will encrypt + send as soon
    // as keys are ready. Plaintext never leaves the device in clear.
    if (allowPlaintext && !isEncryptionActive) {
      const { error } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body: sanitized,
          image_url: imageUrl || null,
        });
      if (error) throw error;
      if (!isSpecial) recordSentMessage(sanitized);
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      return;
    }

    // Case B — encrypted peer conversation: ALWAYS go through the queue.
    // The queue encrypts before send, retries on transient failures, and
    // never falls back to plaintext.
    const queued = await messageQueue.enqueue({
      conversationId,
      senderId: user.id,
      plaintext: sanitized,
      imageUrl,
    });

    if (!isSpecial) recordSentMessage(sanitized);
    return queued;
  }, [user, conversationId, isEncryptionActive, allowPlaintext, queryClient]);

  /** Retry a failed message */
  const retryMessage = useCallback(async (localId: string) => {
    await messageQueue.retryMessage(localId);
  }, []);

  /** Remove a failed message */
  const removeMessage = useCallback(async (localId: string) => {
    await messageQueue.removeMessage(localId);
    plaintextCacheRef.current.delete(localId);
    setRawPendingMessages(prev => prev.filter(m => m.localId !== localId));
  }, []);

  // Enrich pending messages with volatile plaintext from memory cache
  const pendingMessages = rawPendingMessages
    .map(m => ({
      ...m,
      plaintext: m.plaintext || plaintextCacheRef.current.get(m.localId) || '',
    }));

  return {
    pendingMessages,
    sendMessage,
    retryMessage,
    removeMessage,
    /** Whether sending is instant (E2EE ready) or queued */
    isInstant: !isEncryptionActive || isEncryptionReady,
  };
}
