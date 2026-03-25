/**
 * useMessageQueue - React hook for the persistent local message queue.
 * 
 * Strategy:
 * - When E2EE is ready: encrypt + send directly (instant, no queue)
 * - When E2EE is active but not ready yet: queue with retry until encryption available
 * - Zeus conversations: send plaintext directly
 * - NEVER sends plaintext for encrypted conversations
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { messageQueue, type OutboundMessage } from '@/lib/messaging/messageQueue';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';

export function useMessageQueue(
  conversationId: string,
  encrypt: ((plaintext: string) => Promise<string>) | null,
  isEncryptionReady: boolean,
  isEncryptionActive: boolean,
) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pendingMessages, setPendingMessages] = useState<OutboundMessage[]>([]);
  const handlerIdRef = useRef(crypto.randomUUID());
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
      encrypt: async (plaintext: string, _convId: string) => {
        if (!activeRef.current) {
          throw new Error('Encryption not active');
        }
        if (!encryptRef.current) {
          throw new Error('Encryption initializing');
        }
        if (!readyRef.current) {
          throw new Error('Encryption not ready yet');
        }
        return encryptRef.current(plaintext);
      },
      send: async (msg: OutboundMessage) => {
        if (!msg.encryptedBody) {
          throw new Error('Message not encrypted');
        }

        const outboundId = msg.serverId ?? crypto.randomUUID();
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

        if (error?.code === '23505') return outboundId;
        if (error) throw error;

        await supabase
          .from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', msg.conversationId);

        queryClient.invalidateQueries({ queryKey: ['messages', msg.conversationId] });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });

        return outboundId;
      },
      isReady: (_convId: string) => {
        return readyRef.current && activeRef.current;
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
      setPendingMessages(forConv);
    });

    // Clean up stuck messages older than 60s on mount
    messageQueue.getPendingMessages(conversationId).then(async (msgs) => {
      const now = Date.now();
      const stuckThreshold = 60_000;
      for (const msg of msgs) {
        if ((msg.status === 'waiting_secure_channel' || msg.status === 'retry_pending') &&
            now - msg.createdAt > stuckThreshold) {
          await messageQueue.removeMessage(msg.localId);
        }
      }
      const remaining = msgs.filter(m =>
        !((m.status === 'waiting_secure_channel' || m.status === 'retry_pending') && now - m.createdAt > stuckThreshold)
      );
      setPendingMessages(remaining);
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

    const isSpecial = body.startsWith('🎙️ voice:') || body === '📷 Photo';
    if (!isSpecial) {
      const validation = validateMessage(body);
      if (!validation.valid) throw new Error(validation.error);
    }

    const sanitized = isSpecial ? body : sanitizeMessageBody(body);

    // Case 1: Not an encrypted conversation (Zeus) → plaintext direct
    if (!isEncryptionActive) {
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

    // Case 2: E2EE ready → encrypt and send directly (instant)
    if (isEncryptionReady && encrypt) {
      try {
        const encrypted = await encrypt(sanitized);
        if (encrypted && encrypted !== sanitized && encrypted.startsWith('{')) {
          const { error } = await supabase
            .from('messages')
            .insert({
              conversation_id: conversationId,
              sender_id: user.id,
              body: encrypted,
              image_url: imageUrl || null,
            });
          if (error) throw error;
          if (!isSpecial) recordSentMessage(sanitized);
          queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
          queryClient.invalidateQueries({ queryKey: ['conversations'] });
          return;
        }
      } catch (e) {
        console.warn('[MSG] Direct encrypt failed, queuing for retry:', e);
      }
    }

    // Case 3: E2EE active but not ready → queue (will encrypt + send when ready)
    await messageQueue.enqueue({
      conversationId,
      senderId: user.id,
      plaintext: sanitized,
      imageUrl,
    });
    if (!isSpecial) recordSentMessage(sanitized);
  }, [user, conversationId, isEncryptionActive, isEncryptionReady, encrypt, queryClient]);

  /** Retry a failed message */
  const retryMessage = useCallback(async (localId: string) => {
    await messageQueue.retryMessage(localId);
  }, []);

  /** Remove a failed message */
  const removeMessage = useCallback(async (localId: string) => {
    await messageQueue.removeMessage(localId);
    setPendingMessages(prev => prev.filter(m => m.localId !== localId));
  }, []);

  return {
    pendingMessages,
    sendMessage,
    retryMessage,
    removeMessage,
    /** Whether sending is instant (E2EE ready) or queued */
    isInstant: !isEncryptionActive || isEncryptionReady,
  };
}
