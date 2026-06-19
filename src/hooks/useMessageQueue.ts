import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { getOrCreateIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';
import { wrapOutboundSecureMessage } from '@/lib/crypto/secureMessagePipeline';
import { buildFanoutCopies, fanoutMessageCopies } from '@/lib/messaging/multiDeviceFanout';
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

export function buildMultiDeviceParentEnvelope(localId: string, traceId?: string): string {
  return JSON.stringify({
    encryptionMode: 'multi_device',
    v: PROTOCOL_VERSION,
    ct: 'device_copies',
    ts: Date.now(),
    __lid: localId,
    ...(traceId ? { __tid: traceId } : {}),
  });
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

    const updatePending = (patch: Partial<OutboundMessage>) => {
      setPendingMessages(prev => prev.map(m =>
        m.localId === localId
          ? { ...m, ...patch, updatedAt: Date.now() }
          : m,
      ));
    };

    // Session freshness must be confirmed before any encrypted send.
    try {
      const { data: sess } = await supabase.auth.getSession();
      const liveUserId = sess.session?.user?.id;
      if (!liveUserId || liveUserId !== user.id) {
        setPendingMessages(prev => prev.filter(m => m.localId !== localId));
        throw new Error('Session expirée — reconnectez-vous pour envoyer.');
      }
    } catch (e) {
      console.warn('[MSG_SEND] getSession failed; aborting encrypted send', e);
      updatePending({
        status: 'failed_visible',
        lastError: 'Session expiree - reconnectez-vous pour envoyer.',
      });
      throw e instanceof Error
        ? e
        : new Error('Session expiree - reconnectez-vous pour envoyer.');
    }

    let bodyToStore = sanitized;
    let encryptedSuccessfully = false;
    let storedMultiDeviceEnvelope = false;

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
            updatePending({ status: 'failed_visible', lastError: errMsg });
            throw encryptError instanceof Error
              ? encryptError
              : new Error(errMsg);
          }

          // For non-safety failures (missing peer bundle, transient ratchet
          // bootstrap), attempt the fan-out path: store a current-protocol
          // multi-device parent envelope and rely on per-device copies for
          // delivery. This is encrypted-only; no plaintext body is persisted.
          bodyToStore = buildMultiDeviceParentEnvelope(localId, traceId);
          storedMultiDeviceEnvelope = true;
          updatePending({ encryptedBody: bodyToStore, status: 'waiting_secure_channel', lastError: errMsg });
        }
      } else {
        console.warn('[MSG_SEND] encrypt handler missing; compatibility send will continue', {
          localId,
          conversationId,
          isEncryptionReady,
        });
      }
    }

    if (isEncryptionActive && !allowPlaintext && !encryptedSuccessfully && !storedMultiDeviceEnvelope) {
      console.warn('[MSG_SEND] blocked non-v5/plaintext fallback for E2EE conversation', {
        localId,
        conversationId,
        isEncryptionReady,
        hasEncryptHandler: !!encrypt,
      });
      updatePending({
        status: 'failed_visible',
        lastError: 'Chiffrement v5 indisponible - restaurez les cles avant envoi.',
      });
      throw new Error('Chiffrement v5 indisponible - restaurez les cles avant envoi.');
    }

    // Long-life encrypted archive: done in background after INSERT (retroactive RPC path).
    // Removes ~50-200ms from perceived send latency.
    const encryptionWasRequired = isEncryptionActive && !allowPlaintext;

    updatePending({ status: 'sending' });

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
      updatePending({ status: 'failed_visible', lastError: error.message });
      throw error;
    }

    console.info('[MSG_SEND] message inserted', {
      localId,
      conversationId,
      serverId: data?.id,
      encryptedSuccessfully,
      storedMultiDeviceEnvelope,
      hasMedia: !!imageUrl,
    });

    if (!isSpecial) recordSentMessage(sanitized);
    if (data?.id) {
      onPlaintextCached?.(data.id, sanitized);

      // Background archive (non-blocking)
      if (shouldArchiveMessageBody({
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
      // Remove optimistic bubble — realtime/refetch will surface the server copy
      setPendingMessages(prev => prev.filter(m => m.localId !== localId));
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
