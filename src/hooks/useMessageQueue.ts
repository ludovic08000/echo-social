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
import {
  buildFanoutCopies,
  fanoutMessageCopies,
  insertFanoutCopyRows,
  type FanoutCopyRow,
} from '@/lib/messaging/multiDeviceFanout';
import { encryptArchive, setMessageArchiveBody } from '@/lib/messaging/archive/archiveKey';
import { hasMediaKey } from '@/lib/crypto/mediaEncrypt';
import { isAppleMobileWebKit } from '@/lib/platform';

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

const FANOUT_TIMEOUT = Symbol('fanout-precommit-timeout');
const IOS_TEXT_FANOUT_PRECOMMIT_BUDGET_MS = 650;
const DESKTOP_TEXT_FANOUT_PRECOMMIT_BUDGET_MS = 450;
const IOS_MEDIA_FANOUT_PRECOMMIT_BUDGET_MS = 900;
const DESKTOP_MEDIA_FANOUT_PRECOMMIT_BUDGET_MS = 650;

function getFanoutPrecommitBudgetMs(isTextOnly: boolean): number {
  const appleMobileWebKit = isAppleMobileWebKit();
  if (isTextOnly) {
    return appleMobileWebKit
      ? IOS_TEXT_FANOUT_PRECOMMIT_BUDGET_MS
      : DESKTOP_TEXT_FANOUT_PRECOMMIT_BUDGET_MS;
  }
  return appleMobileWebKit
    ? IOS_MEDIA_FANOUT_PRECOMMIT_BUDGET_MS
    : DESKTOP_MEDIA_FANOUT_PRECOMMIT_BUDGET_MS;
}

async function withFanoutPrecommitBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | typeof FANOUT_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  promise.catch(() => {});
  return Promise.race<T | typeof FANOUT_TIMEOUT>([
    promise,
    new Promise<typeof FANOUT_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(FANOUT_TIMEOUT), budgetMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function dispatchDecryptRetry(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
  } catch {}
}

function scheduleBackgroundTask(task: () => void, timeoutMs = 2_000): void {
  if (typeof window === 'undefined') {
    setTimeout(task, 0);
    return;
  }

  const ric = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  }).requestIdleCallback;

  if (typeof ric === 'function') {
    ric(task, { timeout: timeoutMs });
    return;
  }

  setTimeout(task, isAppleMobileWebKit() ? 350 : 75);
}

function normalizeSupabaseError(error: any) {
  return {
    message: error?.message ?? String(error ?? 'unknown_error'),
    code: error?.code ?? error?.statusCode ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
    status: error?.status ?? null,
    name: error?.name ?? null,
  };
}

function shouldFallbackToLegacyEncryptedInsert(error: any): boolean {
  const normalized = normalizeSupabaseError(error);
  const text = Object.values(normalized)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    text.includes('401') ||
    text.includes('jwt') ||
    text.includes('not_authenticated') ||
    text.includes('unauthorized') ||
    text.includes('sender_not_conversation_participant') ||
    text.includes('e2ee_plaintext_message_rejected')
  ) {
    return false;
  }

  return true;
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
        console.warn('[MSG_SEND] identity bootstrap failed; encrypted send may be blocked', {
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

          bodyToStore = buildMultiDeviceParentEnvelope(localId, traceId);
          storedMultiDeviceEnvelope = true;
          updatePending({ encryptedBody: bodyToStore, status: 'waiting_secure_channel', lastError: errMsg });
        }
      } else {
        console.warn('[MSG_SEND] encrypt handler missing; plaintext fallback is blocked for E2EE peers', {
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

    const encryptionWasRequired = isEncryptionActive && !allowPlaintext;

    updatePending({ status: 'sending' });

    const serverMessageId = safeUUID();
    const fanoutInput = {
      messageId: serverMessageId,
      conversationId,
      senderUserId: user.id,
      plaintext: sanitized,
    };

    let fanoutRows: FanoutCopyRow[] = [];
    let fanoutHasTargets = false;
    let fanoutTimedOut = false;
    let fanoutPromise: ReturnType<typeof buildFanoutCopies> | null = null;

    if (encryptedSuccessfully || encryptionWasRequired) {
      try {
        fanoutPromise = buildFanoutCopies(fanoutInput);
        const fanout = await withFanoutPrecommitBudget(
          fanoutPromise,
          getFanoutPrecommitBudgetMs(!isSpecial && !imageUrl),
        );
        if (fanout === FANOUT_TIMEOUT) {
          fanoutTimedOut = true;
          console.info('[MSG_SEND] fanout pre-encryption budget elapsed; inserting parent now', {
            localId,
            conversationId,
          });
        } else {
          fanoutRows = fanout.rows;
          fanoutHasTargets = fanout.hasTargets;
        }
      } catch (fanoutBuildError) {
        console.warn('[MSG_SEND] fanout pre-encryption failed; falling back to async fanout', {
          localId,
          conversationId,
          fanoutBuildError,
        });
      }
    }

    const rpcExtra = { ...(extra || {}) } as Record<string, unknown>;
    if (fanoutRows.length > 0 || fanoutTimedOut || storedMultiDeviceEnvelope) {
      rpcExtra.body_kind = 'multi_device';
    }

    const { data: rpcMessageId, error } = await supabase.rpc('send_message_with_device_copies', {
      p_message_id: serverMessageId,
      p_conversation_id: conversationId,
      p_body: bodyToStore,
      p_image_url: imageUrl || null,
      p_extra: rpcExtra as any,
      p_copies: fanoutRows as any,
    });

    let data = { id: (rpcMessageId as unknown as string) || serverMessageId };
    let usedLegacyEncryptedFallback = false;

    if (error) {
      const normalizedError = normalizeSupabaseError(error);
      console.error('[MSG_SEND] transactional insert failed', { conversationId, localId, error: normalizedError });

      if (!shouldFallbackToLegacyEncryptedInsert(error)) {
        updatePending({ status: 'failed_visible', lastError: normalizedError.message });
        throw error;
      }

      console.warn('[MSG_SEND] falling back to encrypted legacy insert; RPC needs deploy/update', {
        conversationId,
        localId,
        error: normalizedError,
      });
      usedLegacyEncryptedFallback = true;

      const { data: legacyData, error: legacyError } = await supabase
        .from('messages')
        .insert({
          id: serverMessageId,
          conversation_id: conversationId,
          sender_id: user.id,
          body: bodyToStore,
          image_url: imageUrl || null,
          body_kind: String(rpcExtra.body_kind || 'legacy'),
          status: 'delivered',
          view_once: Boolean(extra?.view_once),
          document_url: extra?.document_url ?? null,
          document_name: extra?.document_name ?? null,
          document_mime: extra?.document_mime ?? null,
          document_size_bytes: extra?.document_size_bytes ?? null,
        } as any)
        .select('id')
        .single();

      if (legacyError) {
        const normalizedLegacyError = normalizeSupabaseError(legacyError);
        console.error('[MSG_SEND] encrypted legacy insert failed', {
          conversationId,
          localId,
          error: normalizedLegacyError,
        });
        updatePending({ status: 'failed_visible', lastError: normalizedLegacyError.message });
        throw legacyError;
      }

      data = { id: legacyData?.id || serverMessageId };

      if (fanoutRows.length > 0) {
        try {
          await insertFanoutCopyRows(fanoutInput, fanoutRows);
          dispatchDecryptRetry();
        } catch (fanoutInsertError) {
          console.warn('[MSG_SEND] legacy fallback fanout insert failed; retrying async fanout', {
            localId,
            conversationId,
            messageId: data.id,
            fanoutInsertError,
          });
          void fanoutMessageCopies(fanoutInput).then(dispatchDecryptRetry).catch(() => {});
        }
      }
    }

    console.info('[MSG_SEND] message inserted', {
      localId,
      conversationId,
      serverId: data.id,
      method: usedLegacyEncryptedFallback ? 'encrypted_legacy_fallback' : 'transactional_rpc',
      encryptedSuccessfully,
      storedMultiDeviceEnvelope,
      hasMedia: !!imageUrl,
      fanoutCopies: fanoutRows.length,
      fanoutHasTargets,
      fanoutTimedOut,
    });

    if (!isSpecial) recordSentMessage(sanitized);
    if (data?.id) {
      onPlaintextCached?.(data.id, sanitized);

      if (shouldArchiveMessageBody({
        sanitized,
        isSpecial,
        viewOnce: extra?.view_once === true,
        encryptedSuccessfully,
        encryptionWasRequired,
      })) {
        scheduleBackgroundTask(() => void (async () => {
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
        })(), 3_000);
      }

      if ((encryptedSuccessfully || encryptionWasRequired) && fanoutTimedOut) {
        const pendingFanout = fanoutPromise ?? buildFanoutCopies(fanoutInput);
        void pendingFanout
          .then(async (fanout) => {
            if (fanout.rows.length > 0) {
              await insertFanoutCopyRows(fanoutInput, fanout.rows);
              dispatchDecryptRetry();
              return;
            }
            if (fanout.hasTargets) {
              await fanoutMessageCopies(fanoutInput);
              dispatchDecryptRetry();
            }
          })
          .catch((fanoutError) => {
            console.warn('[MSG_SEND] async precomputed fanout failed after parent insert', {
              localId,
              conversationId,
              messageId: data.id,
              fanoutError,
            });
            void fanoutMessageCopies(fanoutInput).then(dispatchDecryptRetry).catch(() => {});
          });
      } else if ((encryptedSuccessfully || encryptionWasRequired) && fanoutHasTargets && fanoutRows.length === 0) {
        void fanoutMessageCopies(fanoutInput)
          .then(dispatchDecryptRetry)
          .catch((fanoutError) => {
            console.warn('[MSG_SEND] async multi-device fanout fallback failed', {
              localId,
              conversationId,
              messageId: data.id,
              fanoutError,
            });
          });
      }

      queryClient.setQueriesData<any[]>({ queryKey: ['messages', conversationId] }, (old) => {
        if (!Array.isArray(old) || old.some((m) => m?.id === data.id)) return old;
        return [...old, {
          id: data.id,
          conversation_id: conversationId,
          sender_id: user.id,
          body: bodyToStore,
          image_url: imageUrl || null,
          created_at: new Date().toISOString(),
          status: 'delivered',
          profile: {
            name: user.user_metadata?.name || user.user_metadata?.full_name || user.email || 'Moi',
            avatar_url: user.user_metadata?.avatar_url || null,
          },
        }];
      });

      void import('@/lib/crypto/accountKeyBackup')
        .then(({ requestBackgroundBackup }) => requestBackgroundBackup('message-sent'))
        .catch(() => {});
      await onMessageSent?.(localId);
      setPendingMessages(prev => prev.filter(m => m.localId !== localId));
    }

    scheduleBackgroundTask(() => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }, 2_500);
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
