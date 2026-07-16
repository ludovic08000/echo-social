import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { encryptArchive, setMessageArchiveBody } from '@/lib/messaging/archive/archiveKey';
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { getOrCreateIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';
import { wrapOutboundSecureMessage } from '@/lib/crypto/secureMessagePipeline';
import { buildFanoutCopies, insertFanoutCopyRows, type FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import { fanoutNeedsRepair, repairFanoutWithRetry } from '@/lib/messaging/fanoutRepair';
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

const INLINE_FANOUT_BUDGET_MS = 250;

type FanoutBuildResult = Awaited<ReturnType<typeof buildFanoutCopies>>;

function waitForInlineFanout(fanoutPromise: Promise<FanoutBuildResult>): Promise<FanoutBuildResult | null> {
  return Promise.race([
    fanoutPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), INLINE_FANOUT_BUDGET_MS)),
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

function isAuthenticationError(error: unknown): boolean {
  const text = Object.values(normalizeSupabaseError(error)).filter(Boolean).join(' ').toLowerCase();
  return (
    text.includes('401') ||
    text.includes('jwt') ||
    text.includes('not_authenticated') ||
    text.includes('unauthorized')
  );
}

function shouldFallbackToLegacyEncryptedInsert(error: unknown): boolean {
  const text = Object.values(normalizeSupabaseError(error)).filter(Boolean).join(' ').toLowerCase();
  return !(
    text.includes('401') ||
    text.includes('jwt') ||
    text.includes('not_authenticated') ||
    text.includes('unauthorized') ||
    text.includes('sender_not_conversation_participant') ||
    text.includes('e2ee_plaintext_message_rejected') ||
    text.includes('e2ee_missing_device_copies') ||
    text.includes('e2ee_invalid_device_copy') ||
    text.includes('empty_device_copies')
  );
}

function encryptedPayloadKind(payload: string): string {
  try {
    const parsed = JSON.parse(payload);
    return parsed?.encryptionMode || parsed?.fs_secure_pipeline
      ? String(parsed.encryptionMode || 'secure_pipeline')
      : 'json_unknown';
  } catch {
    if (payload.startsWith('sk1.')) return 'sender_key';
    if (payload.startsWith('x3dh') || payload.startsWith('x3dh5')) return 'x3dh_wire';
    return 'opaque';
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

  const sendMessage = useCallback(async (body: string, imageUrl?: string | null, extra?: SendExtra) => {
    const effectiveBody = inferMediaBody(body, imageUrl);
    if (!user || (!effectiveBody.trim() && !imageUrl)) return;

    const isSpecial = isSpecialMessage(effectiveBody, imageUrl);
    if (!isSpecial) {
      const validation = validateMessage(effectiveBody);
      if (!validation.valid) throw new Error(validation.error);
    }

    const sanitized = isSpecial ? effectiveBody : sanitizeMessageBody(effectiveBody);
    const now = Date.now();
    const traceStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const localId = `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId: string = safeUUID();
    const serverMessageId = safeUUID();
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
        ...traceExtra,
      });
    };
    trace('created', {
      bodyLength: sanitized.length,
      bodyBytes: utf8ByteLength(sanitized),
      isSpecial,
    });

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
    let outboxSnapshot: OutboxPayload = {
      ...optimistic,
      extra,
      reservedServerId: serverMessageId,
    };
    setPendingMessages(prev => [...prev.filter((message) => message.localId !== localId), optimistic]);
    void putOutboxPayload(user.id, outboxSnapshot).catch((error) => {
      console.warn('[OUTBOX] initial persist failed', error);
    });

    const updatePending = (patch: Partial<OutboundMessage>) => {
      const updatedAt = Date.now();
      outboxSnapshot = {
        ...outboxSnapshot,
        ...patch,
        updatedAt,
        reservedServerId: patch.serverId ?? outboxSnapshot.reservedServerId,
      };
      setPendingMessages(prev => prev.map(message =>
        message.localId === localId ? { ...message, ...patch, updatedAt } : message,
      ));
      void putOutboxPayload(user.id, outboxSnapshot).catch(() => {});
    };

    let transportPlaintext = sanitized;
    let bodyToStore = sanitized;
    let encryptedSuccessfully = false;
    const encryptionWasRequired = isEncryptionActive && !allowPlaintext;
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
          trace('identity_cold_start_failed_non_fatal', { error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (!encrypt) {
        updatePending({ status: 'failed_visible', lastError: 'Chiffrement indisponible.' });
        throw new Error('Chiffrement indisponible.');
      }

      if (requiresLongAttachment) {
        try {
          trace('long_message_upload_start', { bodyBytes: utf8ByteLength(sanitized) });
          const prepared = await prepareLongMessageForSend(sanitized, serverMessageId);
          transportPlaintext = prepared.transportBody;
          bodyToStore = transportPlaintext;
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

      try {
        trace('encrypt_start');
        const encryptedPayload = await encrypt(transportPlaintext, localId);
        if (!encryptedPayload || encryptedPayload === transportPlaintext) throw new Error('Chiffrement v5 indisponible.');
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
        } catch {
          bodyToStore = encryptedPayload;
        }
        encryptedSuccessfully = true;
        updatePending({ encryptedBody: bodyToStore });
        trace('encrypted_ready_for_rpc', {
          bodyKind: encryptedPayloadKind(bodyToStore),
          bodyLength: bodyToStore.length,
          longMessage: requiresLongAttachment,
        });
      } catch (encryptError) {
        const errMsg = encryptError instanceof Error ? encryptError.message : String(encryptError);
        const normalized = errMsg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const isSafetyMismatch = normalized.includes('cle de securite du contact modifiee') || normalized.includes('safety number changed') || normalized.includes('security key changed') || normalized.includes('verification obligatoire avant envoi') || normalized.includes('fingerprint changed');
        if (isSafetyMismatch) {
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-contact-verification-required', { detail: { conversationId, localId, reason: errMsg } }));
          } catch {
            /* best-effort browser notification */
          }
          updatePending({ status: 'failed_visible', lastError: errMsg });
        } else {
          updatePending({ encryptedBody: null, status: 'waiting_secure_channel', lastError: errMsg });
        }
        throw encryptError instanceof Error ? encryptError : new Error(errMsg);
      }
    }

    updatePending({ status: 'sending', serverId: serverMessageId });
    outboxSnapshot = { ...outboxSnapshot, reservedServerId: serverMessageId, updatedAt: Date.now() };
    void putOutboxPayload(user.id, outboxSnapshot).catch(() => {});

    const fanoutInput = {
      messageId: serverMessageId,
      conversationId,
      senderUserId: user.id,
      plaintext: transportPlaintext,
    };
    let fanoutRows: FanoutCopyRow[] = [];
    let fanoutNeedsAsyncRepair = false;
    let fanoutPromise: ReturnType<typeof buildFanoutCopies> | null = null;
    const archiveAllowed = isArchiveBackupEnabled() && shouldArchiveMessageBody({
      sanitized,
      isSpecial,
      viewOnce: extra?.view_once,
      encryptedSuccessfully,
      encryptionWasRequired,
    });

    if (encryptedSuccessfully) {
      fanoutPromise = buildFanoutCopies(fanoutInput);
      fanoutPromise.catch(() => {});
      const inlineFanout = await waitForInlineFanout(fanoutPromise).catch(() => null);
      if (inlineFanout) {
        fanoutRows = inlineFanout.rows;
        fanoutNeedsAsyncRepair = fanoutNeedsRepair(inlineFanout);
      } else {
        fanoutNeedsAsyncRepair = true;
      }
    }

    const rpcExtra = { ...(extra || {}) } as Record<string, unknown>;
    if (fanoutRows.length > 0) rpcExtra.body_kind = 'multi_device';

    const { data: rpcMessageId, error } = await supabase.rpc('send_message_with_device_copies', {
      p_message_id: serverMessageId,
      p_conversation_id: conversationId,
      p_body: bodyToStore,
      p_image_url: imageUrl || null,
      p_extra: rpcExtra as never,
      p_copies: fanoutRows as never,
    });

    let data = { id: (rpcMessageId as unknown as string) || serverMessageId };
    let usedLegacyEncryptedFallback = false;

    if (error) {
      const normalizedError = normalizeSupabaseError(error);
      if (!shouldFallbackToLegacyEncryptedInsert(error)) {
        const visibleMessage = isAuthenticationError(error)
          ? 'Session expirée — reconnectez-vous pour envoyer.'
          : normalizedError.message;
        updatePending({ status: 'failed_visible', lastError: visibleMessage });
        throw error;
      }
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
        } as never)
        .select('id')
        .single();
      if (legacyError) {
        const visibleMessage = isAuthenticationError(legacyError)
          ? 'Session expirée — reconnectez-vous pour envoyer.'
          : normalizeSupabaseError(legacyError).message;
        updatePending({ status: 'failed_visible', lastError: visibleMessage });
        throw legacyError;
      }
      data = { id: legacyData?.id || serverMessageId };
    }

    trace('message_inserted', {
      serverId: data.id,
      method: usedLegacyEncryptedFallback ? 'encrypted_legacy_fallback' : 'transactional_rpc',
      longMessage: requiresLongAttachment,
    });

    if (!isSpecial) recordSentMessage(sanitized);
    if (data?.id) {
      onPlaintextCached?.(data.id, sanitized);
      if (encryptedSuccessfully) {
        void savePlaintext(data.id, sanitized);
        void savePlaintextForCiphertext(bodyToStore, sanitized);
        dispatchDecryptRetry(data.id);
      }

      if (archiveAllowed) {
        const archiveMsgId = data.id;
        void encryptArchive(sanitized, conversationId, user.id)
          .then(async (archived) => {
            if (!archived) return;
            const stored = await setMessageArchiveBody(archiveMsgId, archived);
            if (stored) dispatchDecryptRetry(archiveMsgId);
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
        if (old.some((message) => message?.id === data.id)) return old;
        return [...old, sentMessage];
      };
      queryClient.setQueryData<SentMessageSnapshot[]>(['messages', conversationId, user.id], upsertSentMessage);
      queryClient.setQueriesData<SentMessageSnapshot[]>({ queryKey: ['messages', conversationId] }, upsertSentMessage);

      if (encryptedSuccessfully && (fanoutNeedsAsyncRepair || usedLegacyEncryptedFallback)) {
        const pendingFanout = fanoutPromise ?? buildFanoutCopies(fanoutInput);
        void pendingFanout.then(async (fanout) => {
          if (!fanout.hasTargets) return;

          const needsRepair = fanoutNeedsRepair(fanout);
          if (fanout.rows.length > 0) {
            const inserted = await insertFanoutCopyRows(fanoutInput, fanout.rows);
            if (inserted.inserted > 0) dispatchDecryptRetry(data.id);
            if (inserted.inserted > 0 && !needsRepair) return;
          }

          const repaired = await repairFanoutWithRetry(fanoutInput);
          if (repaired.inserted > 0) dispatchDecryptRetry(data.id);
        }).catch(() => {
          void repairFanoutWithRetry(fanoutInput).then((repaired) => {
            if (repaired.inserted > 0) dispatchDecryptRetry(data.id);
          }).catch((repairError) => {
            console.warn('[MSG_SEND] fanout repair exhausted', { messageId: data.id, repairError });
          });
        });
      }

      setPendingMessages(prev => prev.filter(message => message.localId !== localId));
      void deleteOutboxPayload(localId).catch(() => {});
      void Promise.resolve(onMessageSent?.(localId)).catch((callbackError) => {
        console.warn('[MSG_SEND] post-send callback failed', { localId, callbackError });
      });
    }

    scheduleLightConversationRefresh(queryClient);
  }, [user, conversationId, encrypt, isEncryptionReady, isEncryptionActive, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]);

  const retryMessage = useCallback(async (localId: string) => {
    if (!user) return;
    const payload = await getOutboxPayload(user.id, localId);
    if (!payload) return;

    if (payload.reservedServerId) {
      const { data } = await supabase.from('messages').select('id').eq('id', payload.reservedServerId).maybeSingle();
      if (data?.id) {
        await deleteOutboxPayload(localId).catch(() => {});
        setPendingMessages(prev => prev.filter(message => message.localId !== localId));
        dispatchDecryptRetry(data.id);
        return;
      }
    }

    await deleteOutboxPayload(localId).catch(() => {});
    setPendingMessages(prev => prev.filter(message => message.localId !== localId));
    await sendMessage(payload.plaintext, payload.imageUrl, payload.extra);
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
