import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { safeUUID } from '@/e2ee-session';
import { sendAegisOutboundMessage } from '@/lib/messaging/aegisOutboundEngine';
import { isMultiDeviceEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import type { FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import { savePlaintext } from '@/lib/crypto/plaintextStore';
import { MAX_INLINE_MESSAGE_BODY_BYTES, utf8ByteLength } from '@/lib/messaging/longMessageAttachment';
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

const SEND_TRANSPORT_TIMEOUT_MS = 15_000;
const SEND_CONFIRM_TIMEOUT_MS = 6_000;

async function withSendStageTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${stage} timeout`)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function classifyOutboundFailure(error: unknown): {
  status: 'waiting_secure_channel' | 'retry_pending' | 'failed_visible';
  message: string;
} {
  const raw = error instanceof Error ? error.message : String(error ?? 'Échec de l’envoi chiffré.');
  const text = normalizedErrorText(error);
  const permanent = isAuthenticationError(error) || [
    'verification obligatoire',
    'fingerprint changed',
    'safety number',
    'cle de securite du contact modifiee',
    'pin unlock required',
    'identity_lost_backup_available',
  ].some(marker => text.includes(marker));
  const routeUnavailable = [
    'e2ee_device_copies_unavailable',
    'e2ee_device_list_unavailable',
    'e2ee_device_route_unavailable',
    'e2ee_participant_route_unavailable',
    'e2ee_no_secure_target',
    'device_prekey_bundle_unavailable',
    'signed_device_list_missing',
    'no canonical signed device list',
    'device_spk_signature_invalid',
  ].some(marker => text.includes(marker));
  return {
    status: permanent
      ? 'failed_visible'
      : routeUnavailable
        ? 'waiting_secure_channel'
        : 'retry_pending',
    message: isAuthenticationError(error)
      ? 'Session expirée — reconnectez-vous pour envoyer.'
      : raw || 'Échec de l’envoi chiffré.',
  };
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

export function selectInitialDeliveryMode(input: {
  encryptionWasRequired: boolean;
  resumedEncryptedBody?: string | null;
  preparedCopyCount: number;
}): 'multi_device' | 'plaintext' {
  if (!input.encryptionWasRequired) return 'plaintext';
  return 'multi_device';
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

export function useAegisMessageQueue(
  conversationId: string,
  _encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,
  isEncryptionReady: boolean,
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
        if (!allowPlaintext && payload.encryptedBody && !isMultiDeviceEnvelopeBody(payload.encryptedBody)) {
          await deleteOutboxPayload(payload.localId).catch(() => {});
          continue;
        }
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
  }, [allowPlaintext, conversationId, user?.id]);

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
        encryptionWasRequested: !allowPlaintext,
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
      status: resumePayload ? 'retry_pending' : 'pending_local',
      retryCount: resumePayload ? resumePayload.retryCount + 1 : 0,
      maxRetries: resumePayload?.maxRetries ?? 5,
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
      keyCapsule: resumePayload?.keyCapsule ?? null,
      preparedCopies: resumePayload?.preparedCopies ?? [],
      archiveBody: null,
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
    };

    trace('created', {
      bodyLength: sanitized.length,
      bodyBytes: utf8ByteLength(sanitized),
      isSpecial,
    });

    // Plaintext is a policy exception reserved for Zeus. Readiness flags are
    // deliberately ignored here: a cold peer route must wait in the encrypted
    // outbox and can never downgrade the request body sent to the server.
    const encryptionWasRequired = !allowPlaintext;

    if (!encryptionWasRequired) {
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
        await persistOutbox().catch(() => undefined);
        throw error instanceof Error ? error : new Error(message);
      }
    } else {
      trace('aegis_durability_delegated');
    }

    updatePending({
      status: encryptionWasRequired ? 'encrypting' : 'sending',
      lastError: null,
    });
    const deliveryMode = selectInitialDeliveryMode({
      encryptionWasRequired,
      resumedEncryptedBody: resumePayload?.encryptedBody ?? null,
      preparedCopyCount: resumePayload?.preparedCopies?.length ?? 0,
    });
    let bodyToStore = resumePayload?.encryptedBody ?? sanitized;
    let encryptedSuccessfully = false;
    let fanoutRows: FanoutCopyRow[] = [];
    const requiresLongAttachment = !isSpecial && utf8ByteLength(sanitized) > MAX_INLINE_MESSAGE_BODY_BYTES;

    updatePending({
      status: deliveryMode === 'multi_device' ? 'encrypting' : 'sending',
      serverId: serverMessageId,
      lastError: null,
    });

    let data = { id: serverMessageId };
    let sendMethod = 'plaintext_system';
    let retriedStaleRoute = false;

    if (deliveryMode === 'plaintext') {
      // The Zeus exception keeps its own durable outbox lifecycle. Encrypted
      // peer traffic is persisted exclusively by the Aegis engine below.
      await persistOutbox({ status: 'sending', lastError: null });
      let insertResponse: { data: unknown; error: unknown };
      try {
        insertResponse = await withSendStageTimeout(
          Promise.resolve(supabase
            .from('messages')
            .insert({
id: serverMessageId,
conversation_id: conversationId,
sender_id: user.id,
body: bodyToStore,
image_url: imageUrl || null,
            body_kind: 'system',
status: 'delivered',
view_once: Boolean(extra?.view_once),
document_url: extra?.document_url ?? null,
document_name: extra?.document_name ?? null,
document_mime: extra?.document_mime ?? null,
document_size_bytes: extra?.document_size_bytes ?? null,
            } as never)
            .select('id')
            .single()),
          SEND_TRANSPORT_TIMEOUT_MS,
          'message transport',
        ) as { data: unknown; error: unknown };
      } catch (error) {
        const failure = classifyOutboundFailure(error);
        updatePending({ status: failure.status, lastError: failure.message }, {
          encryptedBody: bodyToStore,
          preparedCopies: [],
        });
        await persistOutbox().catch(() => undefined);
        throw error instanceof Error ? error : new Error(failure.message);
      }

      const { data: inserted, error: insertError } = insertResponse;
      const insertedRow = inserted as { id?: string } | null;
      if (insertError) {
        let existing: unknown = null;
        try {
          const confirmation = await withSendStageTimeout(
            Promise.resolve(supabase
              .from('messages')
              .select('id,sender_id,conversation_id')
              .eq('id', serverMessageId)
              .maybeSingle()),
            SEND_CONFIRM_TIMEOUT_MS,
            'message confirmation',
          ) as { data: unknown };
          existing = confirmation.data;
        } catch (confirmationError) {
          const failure = classifyOutboundFailure(confirmationError);
          updatePending({ status: 'retry_pending', lastError: failure.message }, {
            encryptedBody: bodyToStore,
            preparedCopies: [],
          });
          await persistOutbox().catch(() => undefined);
          throw confirmationError instanceof Error
            ? confirmationError
            : new Error(failure.message);
        }
        const existingRow = existing as {
id: string;
sender_id: string;
conversation_id: string;
        } | null;
        const committed = existingRow?.id === serverMessageId
&& existingRow.sender_id === user.id
&& existingRow.conversation_id === conversationId;

        if (!committed) {
const ambiguous = isAmbiguousTransportError(insertError);
const visibleMessage = isAuthenticationError(insertError)
  ? 'Session expirée — reconnectez-vous pour envoyer.'
  : ambiguous
    ? 'Confirmation réseau en attente — nouvel essai automatique.'
    : normalizeSupabaseError(insertError).message;
updatePending({
  status: isAuthenticationError(insertError) ? 'failed_visible' : 'retry_pending',
  lastError: visibleMessage,
}, { encryptedBody: bodyToStore, preparedCopies: [] });
await persistOutbox().catch(() => undefined);
throw new Error(visibleMessage);
        }
      }

      data = { id: insertedRow?.id || serverMessageId };
    } else {
      try {
        const sent = await sendAegisOutboundMessage({
          conversationId,
          senderUserId: user.id,
          plaintext: sanitized,
          imageUrl: imageUrl || null,
          extra,
          localId,
          traceId,
          messageId: serverMessageId,
          createdAt: now,
          resumePayload: outboxSnapshot,
          onState: (payload) => {
            outboxSnapshot = payload;
            setPendingMessages(prev => prev.map(message =>
              message.localId === localId
                ? {
                    ...message,
                    encryptedBody: payload.encryptedBody,
                    status: payload.status,
                    retryCount: payload.retryCount,
                    lastError: payload.lastError,
                    updatedAt: payload.updatedAt,
                    serverId: payload.reservedServerId,
                  }
                : message,
            ));
          },
        });
        data = { id: sent.id };
        bodyToStore = sent.parentBody;
        fanoutRows = sent.copies;
        encryptedSuccessfully = true;
        sendMethod = 'aegis_authoritative_rpc';
        retriedStaleRoute = sent.retriedStaleRoute;
      } catch (error) {
        const failure = classifyOutboundFailure(error);
        updatePending({
          status: failure.status,
          lastError: failure.message,
        });
        throw error instanceof Error ? error : new Error(failure.message);
      }
    }

    trace('message_inserted', {
      serverId: data.id,
      method: sendMethod,
      retriedStaleRoute,
      copyCount: fanoutRows.length,
      longMessage: requiresLongAttachment,
    });

    if (!isSpecial) recordSentMessage(sanitized);
    onPlaintextCached?.(data.id, sanitized);
    if (encryptedSuccessfully) {
      // The Aegis engine owns local caches and archive writes. The queue only
      // wakes mounted bubbles after the authoritative commit.
      dispatchDecryptRetry(data.id);
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

    setPendingMessages(prev => prev.filter(message => message.localId !== localId));
    // Remove the visible pending state immediately after server acknowledgement.
    // A slow IndexedDB delete is harmless: restore reconciliation checks the same
    // stable server UUID and removes an already-delivered row idempotently.
    if (deliveryMode === 'plaintext') {
      void deleteOutboxPayload(localId).catch(() => {});
    }
    void Promise.resolve(onMessageSent?.(localId)).catch(callbackError => {
      console.warn('[MSG_SEND] post-send callback failed', { localId, callbackError });
    });
    scheduleLightConversationRefresh(queryClient);
  }, [user, conversationId, isEncryptionReady, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]);

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

  const markRetryExhausted = useCallback(async (localId: string) => {
    const lastError = 'Envoi interrompu après plusieurs tentatives. Appuyez sur Réessayer.';
    const updatedAt = Date.now();
    setPendingMessages(prev => prev.map(message =>
      message.localId === localId
        ? { ...message, status: 'failed_visible', lastError, updatedAt }
        : message,
    ));
    if (!user) return;
    const payload = await getOutboxPayload(user.id, localId).catch(() => null);
    if (!payload) return;
    await putOutboxPayload(user.id, {
      ...payload,
      status: 'failed_visible',
      lastError,
      updatedAt,
    }).catch(() => undefined);
  }, [user]);

  return {
    pendingMessages,
    sendMessage,
    retryMessage,
    markRetryExhausted,
    removeMessage,
    isInstant: true,
  };
}
