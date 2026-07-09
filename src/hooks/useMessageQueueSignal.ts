import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { encryptArchive } from '@/lib/messaging/archive/archiveKey';
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';
import { useAuth } from '@/lib/auth';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { getOrCreateIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';
import { wrapOutboundSecureMessage } from '@/lib/crypto/secureMessagePipeline';
import { buildFanoutCopies, fanoutMessageCopies, insertFanoutCopyRows, type FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import { hasMediaKey } from '@/lib/crypto/mediaEncrypt';
import { savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';

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

const INLINE_ARCHIVE_BUDGET_MS = 180;
const INLINE_FANOUT_BUDGET_MS = 1_200;

type FanoutBuildResult = Awaited<ReturnType<typeof buildFanoutCopies>>;

function waitForInlineArchive(archivePromise: Promise<string | null>): Promise<string | null> {
  return Promise.race([
    archivePromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), INLINE_ARCHIVE_BUDGET_MS)),
  ]);
}

function waitForInlineFanout(fanoutPromise: Promise<FanoutBuildResult>): Promise<FanoutBuildResult | null> {
  return Promise.race([
    fanoutPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), INLINE_FANOUT_BUDGET_MS)),
  ]);
}

function dispatchDecryptRetry(): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
  } catch {
    // Browser event dispatch is best-effort; sending must never fail because of UI wakeups.
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
    return parsed?.encryptionMode || parsed?.fs_secure_pipeline ? String(parsed.encryptionMode || 'secure_pipeline') : 'json_unknown';
  } catch {
    if (payload.startsWith('sk1.')) return 'sender_key';
    if (payload.startsWith('x3dh') || payload.startsWith('x3dh5')) return 'x3dh_wire';
    return 'opaque';
  }
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

  useEffect(() => setPendingMessages([]), [conversationId]);

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
    const traceStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const localId = `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId = safeUUID();
    const trace = (stage: string, extra: Record<string, unknown> = {}) => {
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
        ...extra,
      });
    };
    trace('created', { bodyLength: sanitized.length, isSpecial });

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
      setPendingMessages(prev => prev.map(m => m.localId === localId ? { ...m, ...patch, updatedAt: Date.now() } : m));
    };

    trace('session_check_start');
    // #1 perf: getSession() can await an in-progress token refresh (network),
    // adding multi-second latency to the first send after idle. Race it against
    // a short timeout; if it's slow we trust the live auth-context `user` (kept
    // current by onAuthStateChange — the hook never runs without an authed user)
    // instead of blocking the send. The strict liveness check still applies on
    // the fast path; a truly invalid token is rejected by RLS server-side.
    const sessProbe = await Promise.race([
      supabase.auth.getSession().then((r) => ({ kind: 'ok' as const, data: r.data })),
      new Promise<{ kind: 'slow' }>((res) => setTimeout(() => res({ kind: 'slow' }), 800)),
    ]);
    if (sessProbe.kind === 'ok') {
      const sess = sessProbe.data;
      if (!sess.session?.user?.id || sess.session.user.id !== user.id) {
        trace('session_invalid', { liveUserId: sess.session?.user?.id ?? null });
        setPendingMessages(prev => prev.filter(m => m.localId !== localId));
        throw new Error('Session expirée — reconnectez-vous pour envoyer.');
      }
    } else {
      trace('session_check_slow_trusting_context');
    }
    trace('session_ok');

    let bodyToStore = sanitized;
    let encryptedSuccessfully = false;
    const encryptionWasRequired = isEncryptionActive && !allowPlaintext;

    if (encryptionWasRequired) {
      try {
        trace('identity_bootstrap_start');
        await ensureUserE2EEIdentity(user.id, { waitForMaintenance: false });
        trace('identity_bootstrap_ok');
      } catch (error) {
        trace('identity_bootstrap_failed_non_fatal', { error: error instanceof Error ? error.message : String(error) });
        console.warn('[MSG_SEND] identity bootstrap failed; encrypted send may be blocked', { localId, conversationId, error });
      }

      if (!encrypt) {
        trace('encrypt_handler_missing');
        updatePending({ status: 'failed_visible', lastError: 'Chiffrement indisponible.' });
        throw new Error('Chiffrement indisponible.');
      }

      try {
        if (!isEncryptionReady) {
          console.info('[MSG_SEND] encryption readiness flag false; attempting encrypt anyway', { localId, conversationId });
        }
        trace('encrypt_start');
        const encryptedPayload = await encrypt(sanitized, localId);
        trace('encrypt_ok', {
          payloadLength: encryptedPayload?.length ?? 0,
          payloadKind: encryptedPayload ? encryptedPayloadKind(encryptedPayload) : 'empty',
        });
        if (!encryptedPayload || encryptedPayload === sanitized) throw new Error('Chiffrement v5 indisponible.');
        try {
          trace('secure_wrap_start');
          const identityKeys = await getOrCreateIdentityKeys(user.id);
          const publicBundle = await exportPublicKeyBundle(identityKeys);
          bodyToStore = await wrapOutboundSecureMessage({
            userId: user.id,
            fingerprint: publicBundle.fingerprint,
            encryptedBody: encryptedPayload,
            conversationId,
            localId,
          });
          trace('secure_wrap_ok', { storedKind: encryptedPayloadKind(bodyToStore), storedLength: bodyToStore.length });
        } catch (wrapError) {
          trace('secure_wrap_failed_using_raw_payload', { error: wrapError instanceof Error ? wrapError.message : String(wrapError) });
          console.warn('[MSG_SEND] secure wrapper failed; using raw encrypted payload', { localId, conversationId, wrapError });
          bodyToStore = encryptedPayload;
        }
        encryptedSuccessfully = true;
        trace('encrypted_ready_for_rpc', { bodyKind: encryptedPayloadKind(bodyToStore), bodyLength: bodyToStore.length });
      } catch (encryptError) {
        const errMsg = encryptError instanceof Error ? encryptError.message : String(encryptError);
        const normalized = errMsg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const isSafetyMismatch = normalized.includes('cle de securite du contact modifiee') || normalized.includes('safety number changed') || normalized.includes('security key changed') || normalized.includes('verification obligatoire avant envoi') || normalized.includes('fingerprint changed');
        trace('encrypt_failed', { isSafetyMismatch, error: errMsg });
        console.warn('[MSG_SEND] encrypt failed; strict E2EE send kept local', { localId, conversationId, isSafetyMismatch, encryptError });
        if (isSafetyMismatch) {
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-contact-verification-required', { detail: { conversationId, localId, reason: errMsg } }));
          } catch {
            // Non-fatal: the send remains blocked and visible even if the UI event is unavailable.
          }
          updatePending({ status: 'failed_visible', lastError: errMsg });
        } else {
          updatePending({ encryptedBody: null, status: 'waiting_secure_channel', lastError: errMsg });
        }
        throw encryptError instanceof Error ? encryptError : new Error(errMsg);
      }
    } else {
      trace('encryption_not_required');
    }

    updatePending({ status: 'sending' });
    trace('status_sending');

    const serverMessageId = safeUUID();
    const fanoutInput = { messageId: serverMessageId, conversationId, senderUserId: user.id, plaintext: sanitized };
    let fanoutRows: FanoutCopyRow[] = [];
    let fanoutHasTargets = false;
    let fanoutTimedOut = false;
    let fanoutPromise: ReturnType<typeof buildFanoutCopies> | null = null;
    const archiveAllowed =
      isArchiveBackupEnabled() &&
      shouldArchiveMessageBody({
        sanitized,
        isSpecial,
        viewOnce: extra?.view_once,
        encryptedSuccessfully,
        encryptionWasRequired,
      });
    const archivePromise: Promise<string | null> = archiveAllowed
      ? encryptArchive(sanitized, conversationId, user.id).catch((archiveError) => {
          trace('archive_encrypt_failed', { error: archiveError instanceof Error ? archiveError.message : String(archiveError) });
          return null;
        })
      : Promise.resolve(null);

    if (encryptedSuccessfully) {
      fanoutPromise = buildFanoutCopies(fanoutInput);
      fanoutPromise.catch(() => {});
      trace('fanout_inline_start', { serverMessageId, budgetMs: INLINE_FANOUT_BUDGET_MS });
      const inlineFanout = await waitForInlineFanout(fanoutPromise).catch((fanoutError) => {
        trace('fanout_inline_failed', { error: fanoutError instanceof Error ? fanoutError.message : String(fanoutError), serverMessageId });
        return null;
      });
      if (inlineFanout) {
        fanoutRows = inlineFanout.rows;
        fanoutHasTargets = inlineFanout.hasTargets;
        trace('fanout_inline_ready', { rows: fanoutRows.length, hasTargets: fanoutHasTargets, serverMessageId });
      } else {
        fanoutTimedOut = true;
        trace('fanout_deferred_start', { serverMessageId });
        console.info('[MSG_SEND] fanout deferred; inserting parent immediately', { localId, conversationId });
      }
    }

    const inlineArchiveBody = archiveAllowed ? await waitForInlineArchive(archivePromise) : null;
    if (archiveAllowed) {
      trace(inlineArchiveBody ? 'archive_inline_ready' : 'archive_inline_deferred', { serverMessageId });
    }

    const rpcExtra = { ...(extra || {}) } as Record<string, unknown>;
    if (inlineArchiveBody) rpcExtra.archive_body = inlineArchiveBody;
    if (fanoutRows.length > 0 || fanoutTimedOut) rpcExtra.body_kind = 'multi_device';

    trace('rpc_insert_start', {
      serverMessageId,
      bodyKind: rpcExtra.body_kind ?? 'legacy',
      encryptedSuccessfully,
      fanoutCopies: fanoutRows.length,
    });
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
      trace('rpc_insert_failed', normalizedError as Record<string, unknown>);
      console.error('[MSG_SEND] transactional insert failed', { conversationId, localId, error: normalizedError });
      if (!shouldFallbackToLegacyEncryptedInsert(error)) {
        updatePending({ status: 'failed_visible', lastError: normalizedError.message });
        throw error;
      }
      usedLegacyEncryptedFallback = true;
      trace('legacy_insert_start');
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
          archive_body: inlineArchiveBody,
        } as never)
        .select('id')
        .single();
      if (legacyError) {
        const normalizedLegacyError = normalizeSupabaseError(legacyError);
        trace('legacy_insert_failed', normalizedLegacyError as Record<string, unknown>);
        updatePending({ status: 'failed_visible', lastError: normalizedLegacyError.message });
        throw legacyError;
      }
      data = { id: legacyData?.id || serverMessageId };
      trace('legacy_insert_ok', { serverId: data.id });
      if (fanoutRows.length > 0) {
        try {
          await insertFanoutCopyRows(fanoutInput, fanoutRows);
          dispatchDecryptRetry();
        } catch {
          void fanoutMessageCopies(fanoutInput).then(dispatchDecryptRetry).catch(() => {});
        }
      }
    } else {
      trace('rpc_insert_ok', { serverId: data.id });
    }

    console.info('[MSG_SEND] message inserted', {
      localId,
      conversationId,
      serverId: data.id,
      method: usedLegacyEncryptedFallback ? 'encrypted_legacy_fallback' : 'transactional_rpc',
      encryptedSuccessfully,
      storedMultiDeviceEnvelope: false,
      hasMedia: !!imageUrl,
      fanoutCopies: fanoutRows.length,
      fanoutHasTargets,
      fanoutTimedOut,
    });
    trace('message_inserted', { serverId: data.id, method: usedLegacyEncryptedFallback ? 'encrypted_legacy_fallback' : 'transactional_rpc' });

    if (!isSpecial) recordSentMessage(sanitized);
    if (data?.id) {
      onPlaintextCached?.(data.id, sanitized);
      if (encryptedSuccessfully) {
        // Own sent messages cannot always decrypt their outbound ratchet frame.
        // Cache by both the server id and ciphertext hash immediately so a
        // realtime echo/refetch cannot blank the bubble while archive/fanout
        // maintenance is still settling.
        void savePlaintext(data.id, sanitized);
        void savePlaintextForCiphertext(bodyToStore, sanitized);
        dispatchDecryptRetry();
      }

      // C (durable history): archive the sender's OWN plaintext under the
      // account master key (server-side, write-once) so sent messages survive
      // local cache purge / device rotation / iOS ITP eviction. Best-effort,
      // non-blocking, sender-only (matches set_message_archive_body), skipped
      // for plaintext sends, view-once, and when the user disabled archiving.
      if (archiveAllowed && !inlineArchiveBody) {
        const archiveMsgId = data.id;
        void (async () => {
          try {
            const archived = await encryptArchive(sanitized, conversationId, user.id);
            if (archived) {
              await supabase.rpc('set_message_archive_body', {
                p_message_id: archiveMsgId,
                p_archive_body: archived,
              });
            }
          } catch { /* best-effort — never blocks send */ }
        })();
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

      if (encryptedSuccessfully && fanoutTimedOut) {
        const pendingFanout = fanoutPromise ?? buildFanoutCopies(fanoutInput);
        void pendingFanout
          .then(async (fanout) => {
            trace('fanout_async_built', { rows: fanout.rows.length, hasTargets: fanout.hasTargets, serverMessageId: data.id });
            if (fanout.rows.length > 0) {
              await insertFanoutCopyRows(fanoutInput, fanout.rows);
              trace('fanout_async_inserted', { rows: fanout.rows.length, serverMessageId: data.id });
              dispatchDecryptRetry();
              return;
            }
            if (fanout.hasTargets) {
              await fanoutMessageCopies(fanoutInput);
              trace('fanout_async_fallback_done', { serverMessageId: data.id });
              dispatchDecryptRetry();
            }
          })
          .catch((fanoutError) => {
            trace('fanout_async_failed', { error: fanoutError instanceof Error ? fanoutError.message : String(fanoutError), serverMessageId: data.id });
            console.warn('[MSG_SEND] async fanout failed after parent insert', { localId, conversationId, messageId: data.id, fanoutError });
            void fanoutMessageCopies(fanoutInput).then(dispatchDecryptRetry).catch(() => {});
          });
      }

      await onMessageSent?.(localId);
      setPendingMessages(prev => prev.filter(m => m.localId !== localId));
    }

    scheduleLightConversationRefresh(queryClient);
  }, [user, conversationId, encrypt, isEncryptionReady, isEncryptionActive, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]);

  const retryMessage = useCallback(async (localId: string) => {
    setPendingMessages(prev => prev.map(m => m.localId === localId ? { ...m, status: 'failed_visible', lastError: 'Relancez l’envoi après initialisation du chiffrement', updatedAt: Date.now() } : m));
  }, []);

  const removeMessage = useCallback(async (localId: string) => {
    setPendingMessages(prev => prev.filter(m => m.localId !== localId));
  }, []);

  return { pendingMessages, sendMessage, retryMessage, removeMessage, isInstant: !isEncryptionActive || allowPlaintext || isEncryptionReady };
}
