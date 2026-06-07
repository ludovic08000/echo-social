import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { getOrCreateIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto';
import { wrapOutboundSecureMessage } from '@/lib/crypto/secureMessagePipeline';
import { fanoutMessageCopies } from '@/lib/messaging/multiDeviceFanout';
import { encryptArchive, setMessageArchiveBody } from '@/lib/messaging/archive/archiveKey';
import { hasMediaKey } from '@/lib/crypto/mediaEncrypt';

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

export function shouldArchiveMessageBody({
  sanitized,
  isSpecial,
  viewOnce,
  encryptedSuccessfully,
  encryptionWasRequired,
}: {
  sanitized: string;
  isSpecial: boolean;
  viewOnce?: boolean;
  encryptedSuccessfully: boolean;
  encryptionWasRequired: boolean;
}): boolean {
  if (!(encryptedSuccessfully || encryptionWasRequired)) return false;
  if (viewOnce) return false;
  if (!isSpecial) return true;
  return hasMediaKey(sanitized);
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

    const isSpecial = isSpecialMessage(effectiveBody, imageUrl);

    if (!isSpecial) {
      const validation = validateMessage(effectiveBody);
      if (!validation.valid) throw new Error(validation.error);
    }

    const sanitized = isSpecial ? effectiveBody : sanitizeMessageBody(effectiveBody);
    const now = Date.now();
    const localId = `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId = safeUUID();

    // Optimistic UI: bubble appears instantly while crypto + insert run.
    const optimistic: OutboundMessage = {
      localId,
      traceId,
      conversationId,
      senderId: user.id,
      plaintext: sanitized,
      encryptedBody: null,
      imageUrl: imageUrl || null,
      status: 'encrypting',
      retryCount: 0,
      maxRetries: 3,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      serverId: null,
    };
    setPendingMessages(prev => [...prev, optimistic]);

    // Session freshness check is non-blocking for the UI; throw still cleans pending below.
    try {
      const { data: sess } = await supabase.auth.getSession();
      const liveUserId = sess.session?.user?.id;
      if (!liveUserId || liveUserId !== user.id) {
        setPendingMessages(prev => prev.filter(m => m.localId !== localId));
        throw new Error('Session expirée — reconnectez-vous pour envoyer.');
      }
    } catch (e) {
      // network glitch on getSession shouldn't kill the send if user is present
      console.warn('[MSG_SEND] getSession soft-failed; continuing', e);
    }

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
          // STRICT E2EE: never send plaintext when encryption was required.
          // Safety-number / fingerprint mismatch and any other crypto failure
          // must surface to the UI (user can re-trust identity) and the
          // multi-device fan-out below will still deliver encrypted copies
          // to peer devices via message_device_copies.
          const errMsg = encryptError instanceof Error ? encryptError.message : String(encryptError);
          const normalized = errMsg
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
          const isSafetyMismatch =
            normalized.includes('cle de securite du contact modifiee') ||
            normalized.includes('safety number changed') ||
            normalized.includes('security key changed') ||
            normalized.includes('verification obligatoire avant envoi') ||
            normalized.includes('fingerprint changed');

          console.warn('[MSG_SEND] encrypt failed; will NOT send plaintext (strict E2EE)', {
            localId,
            conversationId,
            isSafetyMismatch,
            encryptError,
          });

          if (isSafetyMismatch) {
            try {
              window.dispatchEvent(new CustomEvent('forsure:e2ee-contact-verification-required', {
                detail: { conversationId, localId, reason: errMsg },
              }));
            } catch {}
            throw encryptError instanceof Error
              ? encryptError
              : new Error(errMsg);
          }

          // For non-safety failures (missing peer bundle, transient ratchet
          // bootstrap), attempt the fan-out path: store an empty placeholder
          // body and rely on per-device copies for delivery.
          bodyToStore = '';
        }
      } else {
        console.warn('[MSG_SEND] encrypt handler missing; compatibility send will continue', {
          localId,
          conversationId,
          isEncryptionReady,
        });
      }
    }

    if (isEncryptionActive && !allowPlaintext && !encryptedSuccessfully) {
      console.warn('[MSG_SEND] blocked non-v5/plaintext fallback for E2EE conversation', {
        localId,
        conversationId,
        isEncryptionReady,
        hasEncryptHandler: !!encrypt,
      });
      throw new Error('Chiffrement v5 indisponible - restaurez les cles avant envoi.');
    }

    // Long-life encrypted archive copy (zero-access, wrapped under account master key).
    // Allows any future device that can unlock the account to re-read this message.
    let archiveBody: string | null = null;
    const encryptionWasRequired = isEncryptionActive && !allowPlaintext;
    if (shouldArchiveMessageBody({
      sanitized,
      isSpecial,
      viewOnce: extra?.view_once === true,
      encryptedSuccessfully,
      encryptionWasRequired,
    })) {
      try {
        archiveBody = await encryptArchive(sanitized, conversationId, user.id);
      } catch {
        archiveBody = null;
      }
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        body: bodyToStore,
        image_url: imageUrl || null,
        ...(archiveBody ? { archive_body: archiveBody } : {}),
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

      // Retroactive archive fallback: if the archive key wasn't available at
      // insert time (e.g. master key still unlocking), try again now and
      // populate archive_body via the RPC. Non-fatal — logs only.
      if (!archiveBody && shouldArchiveMessageBody({
        sanitized,
        isSpecial,
        viewOnce: extra?.view_once === true,
        encryptedSuccessfully,
        encryptionWasRequired,
      })) {
        void (async () => {
          try {
            const retroactive = await encryptArchive(sanitized, conversationId, user.id);
            if (retroactive) {
              const ok = await setMessageArchiveBody(data!.id, retroactive);
              if (ok) {
                console.info('[MSG_SEND] archive_body retroactively set via RPC', {
                  messageId: data!.id,
                  localId,
                });
              }
            }
          } catch (e) {
            console.warn('[MSG_SEND] retroactive archive failed', { messageId: data!.id, localId, e });
          }
        })();
      }

      // Multi-device fan-out: encrypt the plaintext per recipient device
      // (sender's other devices + each participant's devices) so iOS / Windows /
      // Android all receive a readable copy via message_device_copies.
      // Non-fatal: per-conv ratchet still delivers to the bootstrapping device.
      if (encryptedSuccessfully || encryptionWasRequired) {
        void fanoutMessageCopies({
          messageId: data.id,
          conversationId,
          senderUserId: user.id,
          plaintext: sanitized,
        }).catch((fanoutError) => {
          console.warn('[MSG_SEND] multi-device fanout failed', {
            localId,
            conversationId,
            messageId: data.id,
            fanoutError,
          });
        });
      }
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
