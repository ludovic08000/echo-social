/**
 * useMessageQueue — React hook for the persistent local message queue.
 *
 * Security model:
 * - Peer messages always go through the encrypted queue.
 * - Plaintext never leaves the device in clear.
 * - The queue must call encrypt() even before a ratchet is ready, because
 *   encrypt() is responsible for bootstrapping X3DH/ratchet when needed.
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
  const queryClient = useQueryClient();
  const [rawPendingMessages, setRawPendingMessages] = useState<OutboundMessage[]>([]);
  const plaintextCacheRef = useRef<Map<string, string>>(new Map());
  const handlerIdRef = useRef(safeUUID());
  const encryptRef = useRef(encrypt);
  const activeRef = useRef(isEncryptionActive);

  encryptRef.current = encrypt;
  activeRef.current = isEncryptionActive;

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
            errorMessage: 'Encrypt handler not yet wired',
            conversationId: _convId,
            metadata: { localId },
          });
          throw new Error('Encryption initializing');
        }
        try {
          return await encryptRef.current(plaintext, localId);
        } catch (e) {
          logCryptoException('queue.encrypt', e, { conversationId: _convId, metadata: { localId } });
          throw e;
        }
      },

      send: async (msg: OutboundMessage) => {
        if (!msg.encryptedBody) throw new Error('Message not encrypted');

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

        if (msg.plaintext) onPlaintextCached?.(outboundId, msg.plaintext);

        if (msg.plaintext) {
          fanoutMessageCopies({
            messageId: outboundId,
            conversationId: msg.conversationId,
            senderUserId: msg.senderId,
            plaintext: msg.plaintext,
          }).catch(err => console.warn('[FANOUT] non-fatal failure', err));
          processDeviceCopyRetryRequests().catch(() => undefined);
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

      isReady: () => {
        // CRITICAL FIX:
        // Do NOT wait for isEncryptionReady here. In this app, encrypt() is the
        // function that creates/repairs the X3DH + ratchet secure channel.
        // Waiting for isEncryptionReady before calling encrypt() creates an
        // infinite secure_wait loop and makes local pending messages disappear.
        return activeRef.current && !!encryptRef.current;
      },
    });

    // One controlled resume on mount. Further retries are driven by the queue
    // and realtime crypto events, not by render loops.
    queueMicrotask(() => void messageQueue.resumeForConversation(conversationId));

    return () => {
      messageQueue.unregisterHandlers(conversationId, handlerIdRef.current);
    };
  }, [user, conversationId, queryClient, onMessageSent, onPlaintextCached]);

  useEffect(() => {
    if (isEncryptionActive && encrypt && conversationId) {
      messageQueue.resumeForConversation(conversationId);
    }
  }, [isEncryptionActive, !!encrypt, conversationId]);

  useEffect(() => {
    const unsub = messageQueue.subscribe((msgs) => {
      const forConv = msgs.filter(m => m.conversationId === conversationId);
      setRawPendingMessages(forConv);
    });

    messageQueue.getPendingMessages(conversationId).then((msgs) => {
      setRawPendingMessages(msgs);
    });

    return unsub;
  }, [conversationId]);

  useEffect(() => {
    const retry = () => messageQueue.resumeForConversation(conversationId);
    window.addEventListener('online', retry);
    window.addEventListener('forsure-decrypt-retry', retry);
    window.addEventListener('forsure-keys-unlocked', retry);
    window.addEventListener('forsure-keys-restored', retry);
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('forsure-decrypt-retry', retry);
      window.removeEventListener('forsure-keys-unlocked', retry);
      window.removeEventListener('forsure-keys-restored', retry);
    };
  }, [conversationId]);

  const sendMessage = useCallback(async (body: string, imageUrl?: string | null) => {
    if (!user || !body.trim()) return;

    const { data: sess } = await supabase.auth.getSession();
    const liveUserId = sess.session?.user?.id;
    if (!liveUserId || liveUserId !== user.id) {
      throw new Error('🔒 Session expirée — reconnectez-vous pour envoyer.');
    }

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

    const queued = await messageQueue.enqueue({
      conversationId,
      senderId: user.id,
      plaintext: sanitized,
      imageUrl,
    });

    plaintextCacheRef.current.set(queued.localId, sanitized);

    if (!isSpecial) recordSentMessage(sanitized);
    return queued;
  }, [user, conversationId, isEncryptionActive, allowPlaintext, queryClient]);

  const retryMessage = useCallback(async (localId: string) => {
    await messageQueue.retryMessage(localId);
  }, []);

  const removeMessage = useCallback(async (localId: string) => {
    await messageQueue.removeMessage(localId);
    plaintextCacheRef.current.delete(localId);
    setRawPendingMessages(prev => prev.filter(m => m.localId !== localId));
  }, []);

  const pendingMessages = rawPendingMessages.map(m => ({
    ...m,
    plaintext: m.plaintext || plaintextCacheRef.current.get(m.localId) || '',
  }));

  return {
    pendingMessages,
    sendMessage,
    retryMessage,
    removeMessage,
    isInstant: !isEncryptionActive || isEncryptionReady,
  };
}
