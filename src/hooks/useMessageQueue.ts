import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { safeUUID } from '@/e2ee-session';

export interface OutboundMessage {
  localId: string;
  traceId: string;
  conversationId: string;
  senderId: string;
  plaintext: string;
  encryptedBody: string | null;
  imageUrl: string | null;
  status: 'draft' | 'pending_local' | 'encrypting' | 'waiting_secure_channel' | 'sending' | 'sent' | 'retry_pending' | 'failed_visible';
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  serverId: string | null;
}

export function useMessageQueue(
  conversationId: string,
  _encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,
  _isEncryptionReady: boolean,
  isEncryptionActive: boolean,
  _onMessageSent?: (localId: string) => void | Promise<void>,
  allowPlaintext = false,
  onPlaintextCached?: (serverId: string, plaintext: string) => void,
) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pendingMessages, setPendingMessages] = useState<OutboundMessage[]>([]);

  useEffect(() => {
    setPendingMessages([]);
  }, [conversationId]);

  const sendMessage = useCallback(async (body: string, imageUrl?: string | null) => {
    if (!user || !body.trim()) return;

    const { data: sess } = await supabase.auth.getSession();
    const liveUserId = sess.session?.user?.id;
    if (!liveUserId || liveUserId !== user.id) {
      throw new Error('Session expirée — reconnectez-vous pour envoyer.');
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

    // Test mode: when peer E2EE is required, do not start the persistent
    // outbound queue. This stops the encrypt-handler retry loop while the
    // key/PIN recovery flow is being repaired.
    if (isEncryptionActive && !allowPlaintext) {
      const now = Date.now();
      const local: OutboundMessage = {
        localId: `local-${now}-${Math.random().toString(36).slice(2, 8)}`,
        traceId: safeUUID(),
        conversationId,
        senderId: user.id,
        plaintext: sanitized,
        encryptedBody: null,
        imageUrl: imageUrl || null,
        status: 'failed_visible',
        retryCount: 0,
        maxRetries: 0,
        lastError: 'Mode test : E2EE désactivée temporairement',
        createdAt: now,
        updatedAt: now,
        serverId: null,
      };
      setPendingMessages(prev => [...prev, local]);
      console.warn('[TEST] outbound E2EE send blocked without retry', {
        localId: local.localId,
        conversationId,
      });
      return local;
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        body: sanitized,
        image_url: imageUrl || null,
      })
      .select('id')
      .single();

    if (error) throw error;
    if (!isSpecial) recordSentMessage(sanitized);
    if (data?.id) onPlaintextCached?.(data.id, sanitized);
    queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
  }, [user, conversationId, isEncryptionActive, allowPlaintext, queryClient, onPlaintextCached]);

  const retryMessage = useCallback(async (localId: string) => {
    setPendingMessages(prev => prev.map(m =>
      m.localId === localId
        ? { ...m, status: 'failed_visible', lastError: 'Mode test : retry E2EE désactivé', updatedAt: Date.now() }
        : m
    ));
  }, []);

  const removeMessage = useCallback(async (localId: string) => {
    setPendingMessages(prev => prev.filter(m => m.localId !== localId));
  }, []);

  return {
    pendingMessages,
    sendMessage,
    retryMessage,
    removeMessage,
    isInstant: !isEncryptionActive || allowPlaintext,
  };
}
