import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { encryptArchive, setMessageArchiveBody } from '@/lib/messaging/archive/archiveKey';
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';
import { buildFanoutCopies, type FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import { sendMessageWithSesameRetry } from '@/lib/messaging/sesameSendRpc';
import { rollbackFanoutSessionTransaction } from '@/lib/messaging/fanoutSessionTransaction';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { hasMediaKey } from '@/lib/crypto/mediaEncrypt';
import { savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import {
  MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessageForSend,
  utf8ByteLength,
} from '@/lib/messaging/longMessageAttachment';
import {
  deleteOutboxPayload,
  getOutboxPayload,
  listOutboxPayloads,
  putOutboxPayload,
  type OutboxExtra,
  type OutboxPayload,
} from '@/lib/messaging/outboxVault';

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

type SendExtra = OutboxExtra;

type SupabaseErrorLike = {
  message?: unknown;
  code?: unknown;
  statusCode?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
  name?: unknown;
};

type SentMessageSnapshot = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  image_url: string | null;
  created_at: string;
  status: 'delivered';
  profile: {
    name: string;
    avatar_url: string | null;
  };
};

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
  return body.includes('\x00MKEY:') || body.startsWith('🎙️ voice:') || body === '📷 Photo' || body === '🎬 Vidéo' || body === '🎞️ GIF';
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

const INLINE_ARCHIVE_BUDGET_MS = 2_000;

function waitForInlineArchive(archivePromise: Promise<string | null>): Promise<string | null> {
  return Promise.race([
    archivePromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), INLINE_ARCHIVE_BUDGET_MS)),
  ]);
}

function dispatchDecryptRetry(messageId?: string): void {
  try {
    const event = messageId
      ? new CustomEvent('forsure-decrypt-retry', { detail: { messageId } })
      : new CustomEvent('forsure-decrypt-retry');
    window.dispatchEvent(event);
  } catch {
    /* best-effort browser notification */
  }
}

function scheduleLightConversationRefresh(queryClient: ReturnType<typeof useQueryClient>): void {
  if (typeof window === 'undefined') {
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    return;
  }
  window.setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
  }, 1_000);
}

function asSupabaseErrorLike(error: unknown): SupabaseErrorLike {
  return error && typeof error === 'object' ? (error as SupabaseErrorLike) : {};
}

function normalizeSupabaseError(error: unknown) {
  const err = asSupabaseErrorLike(error);
  return {
    message: typeof err.message === 'string' ? err.message : String(error ?? 'unknown_error'),
    code: err.code ?? err.statusCode ?? null,
    details: err.details ?? null,
    hint: err.hint ?? null,
    status: err.status ?? null,
    name: err.name ?? null,
  };
}

function normalizedErrorText(error: unknown): string {
  return Object.values(normalizeSupabaseError(error)).filter(Boolean).join(' ').toLowerCase();
}

function isAuthenticationError(error: unknown): boolean {
  const text = normalizedErrorText(error);
  return (
    text.includes('401') ||
    text.includes('jwt') ||
    text.includes('not_authenticated') ||
    text.includes('unauthorized')
  );
}

function isAmbiguousTransportError(error: unknown): boolean {
  const text = normalizedErrorText(error);
  if (text.includes('e2ee_') || text.includes('not_authenticated') || text.includes('permission denied')) return false;
  return (
    !asSupabaseErrorLike(error).code ||
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('load failed') ||
    text.includes('timeout') ||
    text.includes('connection')
  );
}

function isMultiDeviceParentBody(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed?.encryptionMode === 'multi_device' && parsed?.ct === 'device_copies';
  } catch {
    return false;
  }
}

function toOutboundMessage(payload: OutboxPayload): OutboundMessage {
  return {
    localId: payload.localId,
    traceId: payload.traceId,
    conversationId: payload.conversationId,
    senderId: payload.senderId,
    plaintext: payload.plaintext,
    encryptedBody: payload.encryptedBody,
    imageUrl: payload.imageUrl,
    status: payload.status === 'sent' ? 'retry_pending' : payload.status,
    retryCount: payload.retryCount,
    maxRetries: payload.maxRetries,
    lastError: payload.lastError ?? 'Envoi restauré après redémarrage.',
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    serverId: payload.reservedServerId,
  };
}

export function useMessageQueue(
  conversationId: string,
  _encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,
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
    let cancelled = false;
    setPendingMessages([]);
    if (!user?.id || !conversationId) return;

    void (async () => {
      const payloads = await listOutboxPayloads(user.id, conversationId);
      const reservedIds = payloads
        .map((payload) => payload.reservedServerId)
        .filter((id): id is string => Boolean(id));
      const delivered = new Set<string>();

      if (reservedIds.length > 0) {
        const { data } = await supabase.from('messages').select('id').in('id', reservedIds);
        for (const row of data ?? []) delivered.add(row.id);
      }

      const restored: OutboundMessage[] = [];
      for (const payload of payloads) {
        if (payload.reservedServerId && delivered.has(payload.reservedServerId)) {
          // The authoritative RPC commits the parent and every expected device
          // copy in one transaction. A visible parent therefore proves delivery;
          // rebuilding copies here would advance the local ratchet a second time.
          await deleteOutboxPayload(payload.localId).catch(() => {});
          dispatchDecryptRetry(payload.reservedServerId);
          continue;
        }
        restored.push(toOutboundMessage({
          ...payload,
          status: payload.status === 'sending' || payload.status === 'encrypting'
            ? 'retry_pending'
            : payload.status,
          lastError: payload.lastError ?? 'Envoi restauré après redémarrage.',
        }));
      }

      if (!cancelled) {
        setPendingMessages((current) => {
          const byId = new Map(current.map((message) => [message.localId, message]));
          for (const message of restored) if (!byId.has(message.localId)) byId.set(message.localId, message);
          return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
        });
      }
    })().catch((error) => {
      console.warn('[OUTBOX] restore failed', error);
    });

    return () => { cancelled = true; };
  }, [conversationId, user?.id]);

  const sendMessage = useCallback(async (
    body: string,
    imageUrl?: string | null,
    extra?: SendExtra,
    resumePayload?: OutboxPayload,
  ) => {
    const effectiveBody = inferMediaBody(body, imageUrl);
    if (!user || (!effectiveBody.trim() && !imageUrl)) return;
    if (resumePayload && resumePayload.conversationId !== conversationId) {
      throw new Error('Outbox conversation mismatch.');
    }

    const isSpecial = isSpecialMessage(effectiveBody, imageUrl);
    if (!isSpecial) {
      const validation = validateMessage(effectiveBody);
      if (!validation.valid) throw new Error(validation.error);
    }

    const sanitized = isSpecial ? effectiveBody : sanitizeMessageBody(effectiveBody);
    const now = resumePayload?.createdAt ?? Date.now();
    const traceStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const localId = resumePayload?.localId ?? `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId = resumePayload?.traceId ?? safeUUID();
    const serverMessageId = resumePayload?.reservedServerId ?? safeUUID();
    const trace = (stage: string, traceExtra: Record<string, unknown> = {}) => {
      const elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - traceStartedAt);
      console.info('[MSG_TRACE]', {
        stage,
        elapsedMs,
        localId,
        traceId,
        conversationId,
        userId: user.id,
        encryptionWasRequested: isEncryptionActive && !allowPlaintext,
        isEncryptionReady,
        hasMedia: !!imageUrl,
        resumed: Boolean(resumePayload),
        ...traceExtra,
      });
    };

    const optimistic: OutboundMessage = {
      localId,
      traceId,
      conversationId,
      senderId: user.id,
      plaintext: sanitized,
      encryptedBody: resumePayload?.encryptedBody ?? null,
      imageUrl: imageUrl || null,
      status: resumePayload ? 'retry_pending' : 'encrypting',
      retryCount: resumePayload ? resumePayload.retryCount + 1 : 0,
      maxRetries: resumePayload?.maxRetries ?? 3,
      lastError: null,
      createdAt: now,
      updatedAt: Date.now(),
      serverId: serverMessageId,
    };
    let outboxSnapshot: OutboxPayload = {
      ...(resumePayload ?? {}),
      ...optimistic,
      extra: extra ?? resumePayload?.extra,
      reservedServerId: serverMessageId,
      transportPlaintext: resumePayload?.transportPlaintext ?? null,
      preparedCopies: resumePayload?.preparedCopies ?? [],
      archiveBody: resumePayload?.archiveBody ?? null,
    };
    setPendingMessages(prev => [...prev.filter(message => message.localId !== localId), optimistic]);

    const persistOutbox = async (patch: Partial<OutboxPayload> = {}) => {
      outboxSnapshot = { ...outboxSnapshot, ...patch, updatedAt: Date.now() };
      await putOutboxPayload(user.id, outboxSnapshot);
    };
    const updatePending = (
      patch: Partial<OutboundMessage>,
      outboxPatch: Partial<OutboxPayload> = {},
    ) => {
      const updatedAt = Date.now();
      outboxSnapshot = {
        ...outboxSnapshot,
        ...patch,
        ...outboxPatch,
        updatedAt,
        reservedServerId: patch.serverId ?? outboxSnapshot.reservedServerId,
      };
      setPendingMessages(prev => prev.map(message =>
        message.localId === localId ? { ...message, ...patch, updatedAt } : message,
      ));
      void putOutboxPayload(user.id, outboxSnapshot).catch(() => {});
    };

    trace('created', {
      bodyLength: sanitized.length,
      bodyBytes: utf8ByteLength(sanitized),
      isSpecial,
    });

    try {
      await Promise.all([
        persistOutbox(),
        savePlaintext(serverMessageId, sanitized),
      ]);
      onPlaintextCached?.(serverMessageId, sanitized);
      trace('local_durable');
    } catch (error) {
      const message = 'Stockage local indisponible — message non envoyé.';
      updatePending({ status: 'failed_visible', lastError: message });
      throw error instanceof Error ? error : new Error(message);
    }

    const encryptionWasRequired = isEncryptionActive && !allowPlaintext;
    const resumedParent = isMultiDeviceParentBody(resumePayload?.encryptedBody)
      ? resumePayload.encryptedBody
      : null;
    let transportPlaintext = resumePayload?.transportPlaintext ?? sanitized;
    let bodyToStore = resumedParent ?? sanitized;
    let encryptedSuccessfully = encryptionWasRequired && Boolean(resumedParent);
    const requiresLongAttachment = !isSpecial && utf8ByteLength(sanitized) > MAX_INLINE_MESSAGE_BODY_BYTES;

    if (requiresLongAttachment && !encryptionWasRequired) {
      const error = new Error('Les messages de plus de 2 Kio nécessitent une conversation chiffrée.');
      updatePending({ status: 'failed_visible', lastError: error.message });
      throw error;
    }

    if (encryptionWasRequired) {
      if (!isEncryptionReady) {
        try {
          trace('identity_cold_start');
          await ensureUserE2EEIdentity(user.id, { waitForMaintenance: false });
          trace('identity_cold_start_ready');
        } catch (error) {
          trace('identity_cold_start_failed_non_fatal', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (requiresLongAttachment && !resumePayload?.transportPlaintext) {
        try {
          trace('long_message_upload_start', { bodyBytes: utf8ByteLength(sanitized) });
          const prepared = await prepareLongMessageForSend(sanitized, serverMessageId);
          transportPlaintext = prepared.transportBody;
          await persistOutbox({ transportPlaintext });
          trace('long_message_upload_ready', {
            previewBytes: utf8ByteLength(prepared.preview),
            transportBytes: utf8ByteLength(transportPlaintext),
          });
        } catch (longMessageError) {
          const message = longMessageError instanceof Error
            ? longMessageError.message
            : 'Préparation du message long impossible.';
          updatePending({ status: 'failed_visible', lastError: message });
          throw longMessageError instanceof Error ? longMessageError : new Error(message);
        }
      }

      // The parent is only an encrypted index. Actual content is encrypted for
      // every trusted device by buildFanoutCopies(). Never advance and discard a
      // second conversation ratchet ciphertext before that authoritative path.
      bodyToStore = resumedParent ?? buildMultiDeviceParentEnvelope(localId, traceId);
      encryptedSuccessfully = true;
      await persistOutbox({
        encryptedBody: bodyToStore,
        transportPlaintext,
        preparedCopies: resumePayload?.preparedCopies ?? [],
      });
      updatePending({ encryptedBody: bodyToStore });
      await savePlaintextForCiphertext(bodyToStore, sanitized);
      trace('encrypted_parent_ready', {
        parentBodyLength: bodyToStore.length,
        longMessage: requiresLongAttachment,
      });
    }

    const fanoutInput = {
      messageId: serverMessageId,
      conversationId,
      senderUserId: user.id,
      plaintext: transportPlaintext,
    };
    let fanoutRows: FanoutCopyRow[] = encryptedSuccessfully
      ? (resumePayload?.preparedCopies ?? []).filter(row => row.message_id === serverMessageId)
      : [];

    const archiveAllowed = isArchiveBackupEnabled() && shouldArchiveMessageBody({
      sanitized,
      isSpecial,
      viewOnce: extra?.view_once,
      encryptedSuccessfully,
      encryptionWasRequired,
    });
    let inlineArchiveBody = resumePayload?.archiveBody ?? null;
    const archivePromise = archiveAllowed && !inlineArchiveBody
      ? encryptArchive(sanitized, conversationId, user.id).catch(() => null)
      : Promise.resolve(inlineArchiveBody);

    if (encryptedSuccessfully) {
      updatePending({
        status: 'waiting_secure_channel',
        serverId: serverMessageId,
        lastError: fanoutRows.length > 0
          ? 'Confirmation sécurisée de l’envoi…'
          : 'Préparation des copies chiffrées du destinataire…',
      });

      try {
        if (fanoutRows.length === 0) {
          const fanout = await buildFanoutCopies(fanoutInput);
          if (!fanout.hasTargets || fanout.rows.length === 0) {
            throw new Error('Canal sécurisé du destinataire en cours de préparation.');
          }
          fanoutRows = fanout.rows;
        }

        inlineArchiveBody = await waitForInlineArchive(archivePromise).catch(() => null);
        // Persist exact advanced envelopes before transport. Retry reuses these
        // bytes and the same UUID instead of advancing the ratchet again.
        await persistOutbox({
          transportPlaintext,
          encryptedBody: bodyToStore,
          preparedCopies: fanoutRows,
          archiveBody: inlineArchiveBody,
        });
      } catch (error) {
        await rollbackFanoutSessionTransaction(serverMessageId).catch(() => 0);
        await persistOutbox({ preparedCopies: [] }).catch(() => undefined);
        const message = error instanceof Error
          ? error.message
          : 'Canal sécurisé du destinataire en cours de préparation.';
        updatePending({ status: 'waiting_secure_channel', lastError: message }, { preparedCopies: [] });
        throw error instanceof Error ? error : new Error(message);
      }
    } else if (archiveAllowed) {
      inlineArchiveBody = await waitForInlineArchive(archivePromise).catch(() => null);
      await persistOutbox({ archiveBody: inlineArchiveBody });
    }

    updatePending({ status: 'sending', serverId: serverMessageId, lastError: null });

    const rpcExtra = { ...(extra || {}) } as Record<string, unknown>;
    if (encryptedSuccessfully) rpcExtra.body_kind = 'multi_device';
    if (inlineArchiveBody) rpcExtra.archive_body = inlineArchiveBody;

    let sendResult: Awaited<ReturnType<typeof sendMessageWithSesameRetry>>;
    try {
      sendResult = await sendMessageWithSesameRetry({
        messageId: serverMessageId,
        conversationId,
        body: bodyToStore,
        imageUrl: imageUrl || null,
        extra: rpcExtra,
        senderUserId: user.id,
        senderDeviceId: getCurrentDeviceId(),
        initialCopies: fanoutRows,
        rebuildCopies: async () => {
          const rebuilt = await buildFanoutCopies(fanoutInput);
          if (!rebuilt.hasTargets || rebuilt.rows.length === 0) {
            throw new Error('E2EE_DEVICE_LIST_UNAVAILABLE');
          }
          fanoutRows = rebuilt.rows;
          await persistOutbox({ preparedCopies: fanoutRows });
          return fanoutRows;
        },
      });
    } catch (error) {
      await rollbackFanoutSessionTransaction(serverMessageId).catch(() => 0);
      await persistOutbox({ preparedCopies: [] });
      const visibleMessage = isAuthenticationError(error)
        ? 'Session expirée — reconnectez-vous pour envoyer.'
        : error instanceof Error ? error.message : 'Échec du transport chiffré.';
      updatePending({
        status: isAuthenticationError(error) ? 'failed_visible' : 'retry_pending',
        lastError: visibleMessage,
      }, { preparedCopies: [] });
      throw error instanceof Error ? error : new Error(visibleMessage);
    }

    fanoutRows = sendResult.copies;
    if (sendResult.error) {
      const ambiguous = isAmbiguousTransportError(sendResult.error);
      const normalizedError = normalizeSupabaseError(sendResult.error);
      const visibleMessage = isAuthenticationError(sendResult.error)
        ? 'Session expirée — reconnectez-vous pour envoyer.'
        : ambiguous
          ? 'Confirmation réseau en attente — nouvel essai automatique.'
          : normalizedError.message;
      const retainedCopies = ambiguous ? fanoutRows : [];
      await persistOutbox({ preparedCopies: retainedCopies });
      updatePending({
        status: isAuthenticationError(sendResult.error) ? 'failed_visible' : 'retry_pending',
        lastError: visibleMessage,
      }, { preparedCopies: retainedCopies });
      throw new Error(visibleMessage);
    }

    const data = { id: sendResult.data || serverMessageId };
    trace('message_inserted', {
      serverId: data.id,
      method: sendResult.usedCompatibilitySignature
        ? 'sesame_compatibility_rpc'
        : 'sesame_authoritative_rpc',
      retriedStaleRoute: sendResult.retriedStaleRoute,
      copyCount: fanoutRows.length,
      longMessage: requiresLongAttachment,
    });

    if (!isSpecial) recordSentMessage(sanitized);
    onPlaintextCached?.(data.id, sanitized);
    if (encryptedSuccessfully) {
      await Promise.all([
        savePlaintext(data.id, sanitized),
        savePlaintextForCiphertext(bodyToStore, sanitized),
      ]);
      dispatchDecryptRetry(data.id);
    }

    if (archiveAllowed && !inlineArchiveBody) {
      void archivePromise
        .then(async archived => {
          if (!archived) return;
          const stored = await setMessageArchiveBody(data.id, archived);
          if (stored) dispatchDecryptRetry(data.id);
        })
        .catch(() => {});
    }

    const sentMessage: SentMessageSnapshot = {
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
    };
    const upsertSentMessage = (old: SentMessageSnapshot[] | undefined) => {
      if (!Array.isArray(old)) return [sentMessage];
      if (old.some(message => message?.id === data.id)) return old;
      return [...old, sentMessage];
    };
    queryClient.setQueryData<SentMessageSnapshot[]>(['messages', conversationId, user.id], upsertSentMessage);
    queryClient.setQueriesData<SentMessageSnapshot[]>({ queryKey: ['messages', conversationId] }, upsertSentMessage);

    await deleteOutboxPayload(localId).catch(() => {});
    setPendingMessages(prev => prev.filter(message => message.localId !== localId));
    void Promise.resolve(onMessageSent?.(localId)).catch(callbackError => {
      console.warn('[MSG_SEND] post-send callback failed', { localId, callbackError });
    });
    scheduleLightConversationRefresh(queryClient);
  }, [user, conversationId, isEncryptionReady, isEncryptionActive, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]);

  const retryMessage = useCallback(async (localId: string) => {
    if (!user) return;
    const payload = await getOutboxPayload(user.id, localId);
    if (!payload) return;

    if (payload.reservedServerId) {
      const { data } = await supabase
        .from('messages')
        .select('id')
        .eq('id', payload.reservedServerId)
        .maybeSingle();
      if (data?.id) {
        // Parent + copies are atomic in the authoritative RPC. Do not rebuild or
        // re-encrypt a message that the server has already committed.
        await deleteOutboxPayload(localId).catch(() => {});
        setPendingMessages(prev => prev.filter(message => message.localId !== localId));
        dispatchDecryptRetry(data.id);
        return;
      }
    }

    await sendMessage(payload.plaintext, payload.imageUrl, payload.extra, payload);
  }, [sendMessage, user]);

  const removeMessage = useCallback(async (localId: string) => {
    await deleteOutboxPayload(localId).catch(() => {});
    setPendingMessages(prev => prev.filter(message => message.localId !== localId));
  }, []);

  return {
    pendingMessages,
    sendMessage,
    retryMessage,
    removeMessage,
    isInstant: !isEncryptionActive || allowPlaintext || isEncryptionReady,
  };
}
