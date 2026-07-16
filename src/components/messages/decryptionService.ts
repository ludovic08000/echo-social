/**
 * decryptionService — single crypto entry point for message UI.
 *
 * Resolution order for a single message body:
 *   1. Already-known plaintext (RAM / IndexedDB).
 *   2. Conversation-level Double Ratchet.
 *   3. Per-message Sesame device copy.
 *   4. Multi-session router.
 *   5. Account-wrapped encrypted archive.
 *
 * Bubble Hold invariant: once authenticated plaintext has been displayed for an
 * immutable message id, a later transient retry is never allowed to replace it
 * with an empty result. Only a valid newer result or an explicit message delete
 * may remove it from the UI.
 */
import { hasMediaKey, parseMediaMessage, buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import {
  isLongMessageMarker,
  previewLongMessage,
  resolveLongMessageBody,
} from '@/lib/messaging/longMessageAttachment';
import {
  isCryptoJsonBody,
  isMultiDeviceEnvelopeBody,
  isSecurePipelineEnvelopeBody,
  isStrictRatchetEnvelopeBody,
} from '@/lib/messaging/messageCompatibility';
import {
  loadPlaintext,
  loadPlaintextForCiphertext,
  savePlaintext,
  savePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import { routeIncoming } from '@/e2ee-session';
import { supabase } from '@/integrations/supabase/client';
import { decryptArchive, isArchivePayload } from '@/lib/messaging/archive/archiveKey';
import type { DecryptResult } from '@/hooks/useE2EE';
import { getCachedAuthUserId } from '@/lib/crypto/peerKeyCache';

export interface DecryptionOutcome {
  text: string;
  mediaKeyB64: string | null;
  hidden: boolean;
}

export function looksEncrypted(body: string): boolean {
  return (
    isCryptoJsonBody(body) ||
    isStrictRatchetEnvelopeBody(body) ||
    isMultiDeviceEnvelopeBody(body) ||
    isSecurePipelineEnvelopeBody(body)
  );
}

const CACHE_CAP = 500;
class LruMap<K, V> {
  private m = new Map<K, V>();
  constructor(private readonly cap: number) {}
  get(k: K): V | undefined {
    const value = this.m.get(k);
    if (value !== undefined) {
      this.m.delete(k);
      this.m.set(k, value);
    }
    return value;
  }
  set(k: K, value: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, value);
    while (this.m.size > this.cap) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }
  delete(k: K): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
}

const cache = new LruMap<string, DecryptionOutcome>(CACHE_CAP);
const lastGoodByMessage = new LruMap<string, DecryptionOutcome>(CACHE_CAP);
const inflight = new Map<string, Promise<DecryptionOutcome | null>>();

export function readLastGoodOutcome(messageId?: string): DecryptionOutcome | undefined {
  if (!messageId) return undefined;
  return lastGoodByMessage.get(messageId);
}

export function rememberLastGoodOutcome(
  messageId: string | undefined,
  outcome: DecryptionOutcome,
): void {
  if (!messageId || outcome.hidden || outcome.text === '') return;
  lastGoodByMessage.set(messageId, outcome);
}

export function clearLastGoodOutcome(messageId?: string): void {
  if (messageId) {
    lastGoodByMessage.delete(messageId);
    return;
  }
  lastGoodByMessage.clear();
}

const NEG_TTL_MS = 60_000;
const negCache = new Map<string, number>();
function negCacheHit(key: string): boolean {
  const at = negCache.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > NEG_TTL_MS) {
    negCache.delete(key);
    return false;
  }
  return true;
}

export function clearNegativeCache(messageId?: string, body?: string): void {
  if (messageId !== undefined && body !== undefined) {
    negCache.delete(cacheKey(messageId, body));
    return;
  }
  negCache.clear();
}

export function clearNegativeCacheForMessage(messageId: string): void {
  if (!messageId) return;
  const prefix = `${messageId}|`;
  for (const key of negCache.keys()) {
    if (key.startsWith(prefix)) negCache.delete(key);
  }
}

export function cacheKey(messageId: string | undefined, body: string): string {
  return `${messageId ?? 'noid'}|${body}`;
}

if (typeof window !== 'undefined') {
  const marker = '__forsureDecryptRetryCacheListenerV1';
  const globalWindow = window as typeof window & Record<string, unknown>;
  if (!globalWindow[marker]) {
    globalWindow[marker] = true;
    window.addEventListener('forsure-decrypt-retry', (event: Event) => {
      const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (messageId) {
        clearNegativeCacheForMessage(messageId);
        return;
      }
      clearNegativeCache();
    });
  }
}

const BATCH_WINDOW_MS = 50;
const senderBatchPending = new Map<string, Array<(value: string | null) => void>>();
// Only positive immutable sender ids are cached. A missing row can be caused by
// realtime/RLS/replication timing and must remain retryable.
const senderCache = new LruMap<string, string>(500);
let senderBatchTimer: ReturnType<typeof setTimeout> | null = null;

async function flushSenderBatch(): Promise<void> {
  senderBatchTimer = null;
  const localWaiters = new Map(senderBatchPending);
  senderBatchPending.clear();
  const ids = Array.from(localWaiters.keys());
  if (ids.length === 0) return;
  try {
    const { data } = await supabase
      .from('messages')
      .select('id,sender_id')
      .in('id', ids);
    const map = new Map<string, string>();
    for (const row of (data as Array<{ id: string; sender_id: string | null }> | null) ?? []) {
      if (row.sender_id) map.set(row.id, row.sender_id);
    }
    for (const id of ids) {
      const value = map.get(id) ?? null;
      if (value) senderCache.set(id, value);
      (localWaiters.get(id) ?? []).forEach((resolve) => resolve(value));
    }
  } catch {
    for (const id of ids) {
      (localWaiters.get(id) ?? []).forEach((resolve) => resolve(null));
    }
  }
}

function getSenderIdBatched(messageId: string): Promise<string | null> {
  const cached = senderCache.get(messageId);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise<string | null>((resolve) => {
    const pending = senderBatchPending.get(messageId) ?? [];
    pending.push(resolve);
    senderBatchPending.set(messageId, pending);
    if (!senderBatchTimer) {
      senderBatchTimer = setTimeout(() => void flushSenderBatch(), BATCH_WINDOW_MS);
    }
  });
}

export function readCache(messageId: string | undefined, body: string): DecryptionOutcome | undefined {
  return cache.get(cacheKey(messageId, body));
}

export function dropCache(messageId: string | undefined, body: string): void {
  cache.delete(cacheKey(messageId, body));
}

export function buildOutcomeFromText(text: string): DecryptionOutcome {
  if (hasMediaKey(text)) {
    const parsed = parseMediaMessage(text);
    if (parsed) return { text: parsed.label, mediaKeyB64: parsed.keyB64, hidden: false };
  }
  if (isLongMessageMarker(text)) {
    const preview = previewLongMessage(text);
    if (preview !== null) return { text: preview, mediaKeyB64: null, hidden: false };
  }
  return { text, mediaKeyB64: null, hidden: false };
}

async function buildAuthenticatedOutcomeFromText(
  text: string,
  messageId?: string,
): Promise<DecryptionOutcome> {
  if (!isLongMessageMarker(text)) return buildOutcomeFromText(text);
  if (!messageId) throw new Error('Identifiant absent pour le message long chiffré.');
  const fullBody = await resolveLongMessageBody(text, messageId);
  return buildOutcomeFromText(fullBody);
}

export function persistOutcome(body: string, outcome: DecryptionOutcome, messageId?: string): string {
  const persisted = outcome.mediaKeyB64
    ? buildMediaMessageBody(outcome.text, outcome.mediaKeyB64)
    : outcome.text;
  rememberLastGoodOutcome(messageId, outcome);
  if (messageId) void savePlaintext(messageId, persisted);
  void savePlaintextForCiphertext(body, persisted);
  return persisted;
}

async function loadPersistedOutcome(
  messageId: string | undefined,
  body: string,
): Promise<DecryptionOutcome | null> {
  const byMessageId = messageId
    ? await loadPlaintext(messageId).catch(() => null)
    : null;
  if (byMessageId) {
    if (looksEncrypted(body)) void savePlaintextForCiphertext(body, byMessageId);
    const outcome = await buildAuthenticatedOutcomeFromText(byMessageId, messageId);
    rememberLastGoodOutcome(messageId, outcome);
    return outcome;
  }

  const byCiphertext = await loadPlaintextForCiphertext(body).catch(() => null);
  if (!byCiphertext) return null;
  if (messageId) void savePlaintext(messageId, byCiphertext);
  const outcome = await buildAuthenticatedOutcomeFromText(byCiphertext, messageId);
  rememberLastGoodOutcome(messageId, outcome);
  return outcome;
}

function cacheAndPersist(
  key: string,
  body: string,
  outcome: DecryptionOutcome,
  messageId?: string,
): DecryptionOutcome {
  cache.set(key, outcome);
  persistOutcome(body, outcome, messageId);
  return outcome;
}

function stickyOrNull(messageId?: string): DecryptionOutcome | null {
  return readLastGoodOutcome(messageId) ?? null;
}

export async function resolvePlaintext(opts: {
  body: string;
  messageId?: string;
  senderId?: string | null;
  isMe?: boolean;
  decrypt: (body: string) => Promise<DecryptResult>;
}): Promise<DecryptionOutcome | null> {
  const { body, messageId, decrypt } = opts;

  if (!looksEncrypted(body)) {
    const outcome = { text: body, mediaKeyB64: null, hidden: false };
    rememberLastGoodOutcome(messageId, outcome);
    return outcome;
  }

  const key = cacheKey(messageId, body);
  const cached = cache.get(key);
  if (cached) return cached;

  const persisted = await loadPersistedOutcome(messageId, body).catch(() => null);
  if (persisted) {
    cache.set(key, persisted);
    return persisted;
  }

  if (negCacheHit(key)) return stickyOrNull(messageId);

  let promise = inflight.get(key);
  if (!promise) {
    promise = (async (): Promise<DecryptionOutcome | null> => {
      let senderId: string | null = opts.senderId ?? null;
      let authUserId: string | null | undefined;
      const resolveAuthUserId = async (): Promise<string | null> => {
        if (authUserId === undefined) authUserId = await getCachedAuthUserId();
        return authUserId;
      };

      if (!isMultiDeviceEnvelopeBody(body)) {
        try {
          const result = await decrypt(body);
          if (!result.incompatible) {
            if (result.encrypted && !result.verified && typeof console !== 'undefined') {
              console.warn('[DECRYPT] AEAD-authenticated but Ed25519-unverified plaintext surfaced', {
                messageId,
                kind: isStrictRatchetEnvelopeBody(body) ? 'strict' : 'secure',
              });
            }
            if (result.text !== '') {
              const outcome = await buildAuthenticatedOutcomeFromText(result.text, messageId);
              return cacheAndPersist(key, body, outcome, messageId);
            }
          }
        } catch {
          /* fall through */
        }
      }

      if (messageId) {
        if (!senderId) senderId = await getSenderIdBatched(messageId);
        if (senderId) {
          try {
            const copyText = await tryReadDeviceCopy(messageId, senderId).catch(() => null);
            if (copyText !== null) {
              const outcome = await buildAuthenticatedOutcomeFromText(copyText, messageId);
              return cacheAndPersist(key, body, outcome, messageId);
            }
          } catch {
            /* attachment download/decrypt remains retryable */
          }
        }
      }

      if (isMultiDeviceEnvelopeBody(body)) {
        negCache.set(key, Date.now());
        return stickyOrNull(messageId);
      }

      if (messageId) {
        try {
          const userId = await resolveAuthUserId();
          if (userId && senderId) {
            const routed = await routeIncoming({
              encryptedBody: body,
              recipientUserId: userId,
              senderUserId: senderId,
              messageId,
            });
            if (routed.ok && routed.plaintext !== null) {
              const outcome = await buildAuthenticatedOutcomeFromText(routed.plaintext, messageId);
              return cacheAndPersist(key, body, outcome, messageId);
            }
          }
        } catch {
          /* pending queue will retry */
        }
      }

      let archiveFound = false;
      let archiveDecrypted = false;
      if (messageId) {
        try {
          const userId = await resolveAuthUserId();
          if (userId) {
            const { data: row } = await supabase
              .from('messages')
              .select('archive_body, conversation_id')
              .eq('id', messageId)
              .maybeSingle();
            const conversationId = (row as any)?.conversation_id as string | null | undefined;
            if (conversationId) {
              let archiveBody: string | null = ((row as any)?.archive_body as string | null) ?? null;
              try {
                const { data: mine } = await (supabase as any)
                  .from('message_archives')
                  .select('archive_body')
                  .eq('message_id', messageId)
                  .maybeSingle();
                const mineArchive = (mine as any)?.archive_body as string | null | undefined;
                if (mineArchive) archiveBody = mineArchive;
              } catch {
                /* table may be absent before migration */
              }
              if (archiveBody && isArchivePayload(archiveBody)) {
                archiveFound = true;
                const plaintext = await decryptArchive(archiveBody, conversationId, userId);
                if (plaintext !== null) {
                  archiveDecrypted = true;
                  const outcome = await buildAuthenticatedOutcomeFromText(plaintext, messageId);
                  return cacheAndPersist(key, body, outcome, messageId);
                }
              }
            }
          }
        } catch {
          /* fall through to sticky snapshot */
        }
      }

      if (typeof console !== 'undefined') {
        console.warn('[DECRYPT-FAIL] no fresh path; preserving last valid bubble snapshot', {
          messageId,
          kind: isMultiDeviceEnvelopeBody(body)
            ? 'multidevice'
            : isStrictRatchetEnvelopeBody(body)
              ? 'strict'
              : 'secure_or_future',
          isMe: opts.isMe === true,
          senderId: senderId ? String(senderId).slice(0, 8) : null,
          archiveFound,
          archiveDecrypted,
          stickyAvailable: Boolean(readLastGoodOutcome(messageId)),
        });
      }
      negCache.set(key, Date.now());
      return stickyOrNull(messageId);
    })();
    inflight.set(key, promise);
    promise.finally(() => inflight.delete(key));
  }

  return promise;
}
