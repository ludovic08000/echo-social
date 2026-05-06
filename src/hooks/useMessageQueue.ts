import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { getOrCreateIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto';
import { wrapOutboundSecureMessage } from '@/lib/crypto/secureMessagePipeline';

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

function inferMediaBody(body: string, imageUrl?: string | null): string {
  const trimmed = body.trim();
  if (trimmed) return body;
  if (!imageUrl) return '';

  const lower = imageUrl.toLowerCase().split('?')[0];
  if (lower.endsWith('.gif') || lower.includes('image/gif')) return '🎞️ GIF';
  if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.includes('video')) return '🎬 Vidéo';
  return '📷 Photo';
}

function isSpecialMessage(body: string, imageUrl?: string | null): boolean {
  if (imageUrl) return true;
  return (
    body.includes('\x00MKEY:') ||
    body.startsWith('🎙️ voice:') ||
    body === '📷 Photo' ||
    body === '🎬 Vidéo' ||
    body === '🎞️ GIF'
  );
}

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
  const [pendingMessages, setPendingMessages] = useState<OutboundMessage[]>([]);

  useEffect(() => {
    setPendingMessages([]);
  }, [conversationId]);

  const sendMessage = useCallback(async (body: string, imageUrl?: string | null) => {
    const effectiveBody = inferMediaBody(body, imageUrl);
    if (!user || (!effectiveBody.trim() && !imageUrl)) return;

    const { data: sess } = await supabase.auth.getSession();
    const liveUserId = sess.session?.user?.id;
    if (!liveUserId || liveUserId !== user.id) {
      throw new Error('Session expirée — reconnectez-vous pour envoyer.');
    }

    const isSpecial = isSpecialMessage(effectiveBody, imageUrl);

    if (!isSpecial) {
      const validation = validateMessage(effectiveBody);
      if (!validation.valid) throw new Error(validation.error);
    }

    const sanitized = isSpecial ? effectiveBody : sanitizeMessageBody(effectiveBody);
    const now = Date.now();
    const localId = `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId = safeUUID();

    let bodyToStore = sanitized;

    if (isEncryptionActive && !allowPlaintext) {
      await ensureUserE2EEIdentity(user.id);

      if (!isEncryptionReady || !encrypt) {
        const local: OutboundMessage = {
          localId,
          traceId,
          conversationId,
          senderId: user.id,
          plaintext: sanitized,
          encryptedBody: null,
          imageUrl: imageUrl || null,
          status: 'failed_visible',
          retryCount: 0,
          maxRetries: 0,
          lastError: 'Chiffrement en préparation — réessayez dans quelques secondes',
          createdAt: now,
          updatedAt: now,
          serverId: null,
        };
        setPendingMessages(prev => [...prev, local]);
        return local;
      }

      const encryptedPayload = await encrypt(sanitized, localId);
      if (!encryptedPayload || encryptedPayload === sanitized) {
        throw new Error('Chiffrement indisponible — message non envoyé');
      }

      const identityKeys = await getOrCreateIdentityKeys(user.id);
      const publicBundle = await exportPublicKeyBundle(identityKeys);

      bodyToStore = await wrapOutboundSecureMessage({
        userId: user.id,
        fingerprint: publicBundle.fingerprint,
        encryptedBody: encryptedPayload,
        conversationId,
        localId,
      });
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        body: bodyToStore,
        image_url: imageUrl || null,
      })
      .select('id')
      .single();

    if (error) throw error;
    if (!isSpecial) recordSentMessage(sanitized);
    if (data?.id) {
      onPlaintextCached?.(data.id, sanitized);
      await onMessageSent?.(localId);
    }

    queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
  }, [user, conversationId, encrypt, isEncryptionReady, isEncryptionActive, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]);

  const retryMessage = useCallback(async (localId: string) => {
    setPendingMessages(prev => prev.map(m =>
      m.localId === localId
        ? { ...m, status: 'failed_visible', lastError: 'Relancez l’envoi après initialisation du chiffrement', updatedAt: Date.now() }
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
    isInstant: !isEncryptionActive || allowPlaintext || isEncryptionReady,
  };
}
