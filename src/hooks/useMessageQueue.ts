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

  const sendMessage = useCallback(async (body: string, imageUrl?: string | null, extra?: { view_once?: boolean; document_url?: string | null; document_name?: string | null; document_mime?: string | null; document_size_bytes?: number | null }) => {
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
    let encryptedSuccessfully = false;

    if (isEncryptionActive && !allowPlaintext) {
      try {
        await ensureUserE2EEIdentity(user.id);
      } catch (error) {
        console.warn('[MSG_SEND] identity bootstrap failed; continuing with compatibility send', {
          localId,
          conversationId,
          error,
        });
      }

      if (encrypt) {
        try {
          if (!isEncryptionReady) {
            console.info('[MSG_SEND] encryption readiness flag false; attempting encrypt anyway', {
              localId,
              conversationId,
            });
          }

          const encryptedPayload = await encrypt(sanitized, localId);
          if (encryptedPayload && encryptedPayload !== sanitized) {
            try {
              const identityKeys = await getOrCreateIdentityKeys(user.id);
              const publicBundle = await exportPublicKeyBundle(identityKeys);
              bodyToStore = await wrapOutboundSecureMessage({
                userId: user.id,
                fingerprint: publicBundle.fingerprint,
                encryptedBody: encryptedPayload,
                conversationId,
                localId,
              });
              encryptedSuccessfully = true;
            } catch (wrapError) {
              console.warn('[MSG_SEND] secure wrapper failed; using raw encrypted payload', {
                localId,
                conversationId,
                wrapError,
              });
              bodyToStore = encryptedPayload;
              encryptedSuccessfully = true;
            }
          }
        } catch (encryptError) {
          console.warn('[MSG_SEND] encrypt failed; compatibility send will continue', {
            localId,
            conversationId,
            encryptError,
          });
        }
      } else {
        console.warn('[MSG_SEND] encrypt handler missing; compatibility send will continue', {
          localId,
          conversationId,
          isEncryptionReady,
        });
      }
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        body: bodyToStore,
        image_url: imageUrl || null,
        ...(extra || {}),
      })
      .select('id')
      .single();

    if (error) {
      console.error('[MSG_SEND] database insert failed', { conversationId, localId, error });
      throw error;
    }

    console.info('[MSG_SEND] message inserted', {
      localId,
      conversationId,
      serverId: data?.id,
      encryptedSuccessfully,
      hasMedia: !!imageUrl,
    });

    if (!isSpecial) recordSentMessage(sanitized);
    if (data?.id) {
      onPlaintextCached?.(data.id, sanitized);
      // Critical for iOS/Safari: after the server ACK, persist the newest
      // ratchet state + sender plaintext/media key into the encrypted backup
      // immediately so a WebView cache purge doesn't make recent messages blank.
      void import('@/lib/crypto/accountKeyBackup')
        .then(({ requestImmediateBackup }) => requestImmediateBackup('message-sent'))
        .catch(() => {});
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
