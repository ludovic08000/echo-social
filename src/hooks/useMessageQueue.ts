/**
 * useMessageQueue - React hook for the persistent local message queue.
 * 
 * Integrates with useE2EE to provide:
 * - Queue-based sending (never loses messages)
 * - Automatic retry on failure
 * - Proper encryption before sending
 * - Visual status feedback
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
  const registeredRef = useRef(false);
  const encryptRef = useRef(encrypt);
  const readyRef = useRef(isEncryptionReady);
  const activeRef = useRef(isEncryptionActive);

  // Keep refs fresh
  encryptRef.current = encrypt;
  readyRef.current = isEncryptionReady;
  activeRef.current = isEncryptionActive;

  // Register handlers with the queue
  useEffect(() => {
    if (!user || !conversationId) return;

    messageQueue.registerHandlers({
      encrypt: async (plaintext: string, _convId: string) => {
        if (!activeRef.current) {
          // No encryption needed for this conversation (e.g., Zeus)
          // But we should never send plaintext for encrypted conversations
          throw new Error('Encryption not active');
        }
        if (!encryptRef.current) {
          throw new Error('Encrypt function not available');
        }
        return encryptRef.current(plaintext);
      },
      send: async (msg: OutboundMessage) => {
        if (!msg.encryptedBody) {
          throw new Error('Message not encrypted');
        }

        const { data, error } = await supabase
          .from('messages')
          .insert({
            conversation_id: msg.conversationId,
            sender_id: msg.senderId,
            body: msg.encryptedBody,
            image_url: msg.imageUrl,
          })
          .select('id')
          .single();

        if (error) throw error;

        // Update conversation timestamp
        await supabase
          .from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', msg.conversationId);

        // Refresh messages cache
        queryClient.invalidateQueries({ queryKey: ['messages', msg.conversationId] });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });

        return data.id;
      },
      isReady: (_convId: string) => {
        return readyRef.current && activeRef.current;
      },
    });
    registeredRef.current = true;
  }, [user, conversationId, queryClient]);

  // Resume pending messages when encryption becomes ready
  useEffect(() => {
    if (isEncryptionReady && isEncryptionActive && conversationId) {
      messageQueue.resumeForConversation(conversationId);
    }
  }, [isEncryptionReady, isEncryptionActive, conversationId]);

  // Subscribe to queue updates
  useEffect(() => {
    const unsub = messageQueue.subscribe((msgs) => {
      const forConv = msgs.filter(m => m.conversationId === conversationId);
      setPendingMessages(forConv);
    });

    // Load initial pending
    messageQueue.getPendingMessages(conversationId).then(setPendingMessages);

    return unsub;
  }, [conversationId]);

  // Resume on network restore
  useEffect(() => {
    const handler = () => {
      if (navigator.onLine) {
        messageQueue.resumeForConversation(conversationId);
      }
    };
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, [conversationId]);

  // Resume on page visibility
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') {
        messageQueue.resumeForConversation(conversationId);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [conversationId]);

  /** Send a message through the queue */
  const sendMessage = useCallback(async (body: string, imageUrl?: string | null) => {
    if (!user || !body.trim()) return;

    // Anti-spam
    const isSpecial = body.startsWith('🎙️ voice:') || body === '📷 Photo';
    if (!isSpecial) {
      const validation = validateMessage(body);
      if (!validation.valid) {
        throw new Error(validation.error);
      }
    }

    const sanitized = isSpecial ? body : sanitizeMessageBody(body);

    if (isEncryptionActive) {
      // Queue for encrypted sending
      await messageQueue.enqueue({
        conversationId,
        senderId: user.id,
        plaintext: sanitized,
        imageUrl,
      });

      if (!isSpecial) recordSentMessage(sanitized);
    } else {
      // Non-encrypted conversation (Zeus) — send directly
      const { data, error } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body: sanitized,
          image_url: imageUrl || null,
        })
        .select()
        .single();

      if (error) throw error;
      if (!isSpecial) recordSentMessage(sanitized);

      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  }, [user, conversationId, isEncryptionActive, queryClient]);

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
  };
}
