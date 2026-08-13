/**
 * decryptionService — single crypto entry point for message UI.
 *
 * Aegis v1 resolution order for a single message body:
 *   1. Already-known plaintext for the exact parent ciphertext.
 *   2. The authenticated copy addressed to this device.
 *
 * Unknown encrypted JSON is rejected so ciphertext is never rendered as text.
 * No alternate wire format is decrypted.
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
} from '@/lib/messaging/messageCompatibility';
import {
  loadPlaintext,
  loadPlaintextForCiphertext,
  savePlaintext,
  savePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';
import {
  clearDeviceCopyCache,
  clearDeviceCopyCacheForMessage,
  tryReadDeviceCopy,
} from '@/lib/messaging/multiDeviceFanout';
import {
  openAegisMessage,
  parseAegisMessageEnvelope,
} from '@/lib/messaging/aegisEnvelope';
import { supabase } from '@/integrations/supabase/client';
import type { DecryptResult } from '@/hooks/useE2EE';
import { getCachedAuthUserId } from '@/lib/crypto/peerKeyCache';
import {
  archiveBubbleForUser,
  decryptArchive,
  recoverBubbleFromArchive,
} from '@/lib/messaging/archive/archiveKey';
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';
import { acknowledgeAegisMessage } from '@/lib/messaging/aegisDeviceInbox';

export interface DecryptionOutcome {
  text: string;
  mediaKeyB64: string | null;
  hidden: boolean;
}

export function looksEncrypted(body: string): boolean {
  return isCryptoJsonBody(body) || isMultiDeviceEnvelopeBody(body);
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
type LastGoodEntry = { body: string; outcome: DecryptionOutcome };
const lastGoodByMessage = new LruMap<string, LastGoodEntry>(CACHE_CAP);
const inflight = new Map<string, Promise<DecryptionOutcome | null>>();
const purgedMessageIds = new Set<string>();
const PURGED_MESSAGE_CAP = 2_000;

export function readLastGoodOutcome(
  messageId?: string,
  body?: string,
): DecryptionOutcome | undefined {
  if (!messageId || body === undefined) return undefined;
  const entry = lastGoodByMessage.get(messageId);
  return entry?.body === body ? entry.outcome : undefined;
}

export function rememberLastGoodOutcome(
  messageId: string | undefined,
  outcome: DecryptionOutcome,
  body?: string,
): void {
  if (!messageId || purgedMessageIds.has(messageId) || body === undefined || outcome.hidden || outcome.text === '') return;
  lastGoodByMessage.set(messageId, { body, outcome });
}

export function clearLastGoodOutcome(messageId?: string): void {
  if (messageId) {
    lastGoodByMessage.delete(messageId);
    return;
  }
  lastGoodByMessage.clear();
}

const NEG_TTL_MS = 2_000;
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
        clearDeviceCopyCacheForMessage(messageId);
        return;
      }
      clearNegativeCache();
      clearDeviceCopyCache();
    });
  }
}

const senderCache = new LruMap<string, string>(500);

async function getSenderId(messageId: string): Promise<string | null> {
  const cached = senderCache.get(messageId);
  if (cached !== undefined) return cached;
  try {
    const { data } = await supabase
      .from('messages')
      .select('id,sender_id')
      .in('id', [messageId]);
    const senderId = ((data as Array<{ id: string; sender_id: string | null }> | null) ?? [])
      .find((row) => row.id === messageId)?.sender_id ?? null;
    if (senderId) senderCache.set(messageId, senderId);
    return senderId;
  } catch {
    return null;
  }
}

export function readCache(messageId: string | undefined, body: string): DecryptionOutcome | undefined {
  return cache.get(cacheKey(messageId, body));
}

export function dropCache(messageId: string | undefined, body: string): void {
  cache.delete(cacheKey(messageId, body));
}

export function purgeDecryptionStateForMessage(messageId: string, body?: string): void {
  if (!messageId) return;
  purgedMessageIds.add(messageId);
  while (purgedMessageIds.size > PURGED_MESSAGE_CAP) {
    const oldest = purgedMessageIds.values().next().value as string | undefined;
    if (!oldest) break;
    purgedMessageIds.delete(oldest);
  }
  if (body !== undefined) {
    const key = cacheKey(messageId, body);
    cache.delete(key);
    inflight.delete(key);
  }
  clearLastGoodOutcome(messageId);
  clearNegativeCacheForMessage(messageId);
  senderCache.delete(messageId);
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
  if (messageId && purgedMessageIds.has(messageId)) return persisted;
  rememberLastGoodOutcome(messageId, outcome, body);
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
    rememberLastGoodOutcome(messageId, outcome, body);
    return outcome;
  }

  const byCiphertext = await loadPlaintextForCiphertext(body).catch(() => null);
  if (!byCiphertext) return null;
  if (messageId) void savePlaintext(messageId, byCiphertext);
  const outcome = await buildAuthenticatedOutcomeFromText(byCiphertext, messageId);
  rememberLastGoodOutcome(messageId, outcome, body);
  return outcome;
}

function cacheAndPersist(
  key: string,
  body: string,
  outcome: DecryptionOutcome,
  messageId?: string,
  currentUserId?: string | null,
): Promise<DecryptionOutcome> {
  if (messageId && purgedMessageIds.has(messageId)) return Promise.resolve(outcome);
  cache.set(key, outcome);
  const persisted = outcome.mediaKeyB64
    ? buildMediaMessageBody(outcome.text, outcome.mediaKeyB64)
    : outcome.text;
  rememberLastGoodOutcome(messageId, outcome, body);
  return Promise.all([
    messageId ? savePlaintext(messageId, persisted) : Promise.resolve(),
    savePlaintextForCiphertext(body, persisted),
  ]).then(async () => {
    if (currentUserId && messageId) {
      await acknowledgeAfterPersistence(currentUserId, messageId);
    }
    return outcome;
  });
}

async function acknowledgeAfterPersistence(userId: string, messageId: string): Promise<void> {
  try {
    await acknowledgeAegisMessage(userId, messageId);
  } catch (error) {
    traceE2EE({
      direction: 'receive',
      component: 'decryption_service',
      stage: 'SERVER_INBOX_ACK_FAILED',
      outcome: 'error',
      messageId,
      errorCode: error instanceof Error ? error.message : String(error),
    }, 'error');
    throw error;
  }
}

function scheduleAcknowledgement(userId: string, messageId: string): void {
  void acknowledgeAfterPersistence(userId, messageId).catch(() => {
    // L'échec est déjà tracé et le serveur conserve la capsule pending : la
    // prochaine synchronisation retentera sans faux état livré côté client.
  });
}

function stickyOrNull(messageId: string | undefined, body: string): DecryptionOutcome | null {
  return readLastGoodOutcome(messageId, body) ?? null;
}

export async function resolvePlaintext(opts: {
  body: string;
  messageId?: string;
  senderId?: string | null;
  isMe?: boolean;
  archiveBody?: string | null;
  decrypt: (body: string) => Promise<DecryptResult>;
}): Promise<DecryptionOutcome | null> {
  const { body, messageId, decrypt } = opts;
  if (messageId && purgedMessageIds.has(messageId)) {
    return { text: '', mediaKeyB64: null, hidden: true };
  }
  const traceStartedAt = Date.now();
  const trace = (
    stage: string,
    details: Partial<Parameters<typeof traceE2EE>[0]> = {},
    level: 'info' | 'warn' | 'error' = 'info',
  ) => traceE2EE({
    direction: 'receive',
    component: 'decryption_service',
    stage,
    messageId,
    elapsedMs: Date.now() - traceStartedAt,
    ...details,
  }, level);

  if (!looksEncrypted(body)) {
    const outcome = { text: body, mediaKeyB64: null, hidden: false };
    rememberLastGoodOutcome(messageId, outcome, body);
    return outcome;
  }

  if (!isMultiDeviceEnvelopeBody(body)) return null;
  const aegisEnvelope = parseAegisMessageEnvelope(body);
  if (!aegisEnvelope || (messageId && aegisEnvelope.messageId !== messageId)) return null;

  const key = cacheKey(messageId, body);
  const cached = cache.get(key);
  if (cached) {
    trace('PLAINTEXT_RESOLVE', { outcome: 'ok', cache: 'memory' });
    if (messageId) {
      void getCachedAuthUserId()
        .then((userId) => { if (userId) scheduleAcknowledgement(userId, messageId); });
    }
    return cached;
  }

  const persisted = await loadPersistedOutcome(messageId, body).catch(() => null);
  if (persisted) {
    trace('PLAINTEXT_RESOLVE', { outcome: 'ok', cache: 'disk' });
    cache.set(key, persisted);
    if (messageId) {
      void getCachedAuthUserId()
        .then((userId) => { if (userId) scheduleAcknowledgement(userId, messageId); });
    }
    return persisted;
  }

  if (negCacheHit(key)) {
    trace('PLAINTEXT_RESOLVE', { outcome: 'skip', cache: 'miss' });
    return stickyOrNull(messageId, body);
  }

  let promise = inflight.get(key);
  if (!promise) {
    promise = (async (): Promise<DecryptionOutcome | null> => {
      let senderId: string | null = opts.senderId ?? null;
      void decrypt;

      if (messageId) {
        trace('DEVICE_COPY_LOOKUP', { outcome: 'start', cache: 'network' });
        const currentUserId = await getCachedAuthUserId().catch(() => null);
        if (!senderId) senderId = await getSenderId(messageId);
        if (senderId) {
          try {
            const copyText = await tryReadDeviceCopy(messageId, senderId, {
              requestRetry: true,
            }).catch(() => null);
            if (copyText !== null) {
              trace('DEVICE_COPY_LOOKUP', { outcome: 'ok', cache: 'network' });
              const openStartedAt = Date.now();
              trace('CONTENT_AES_DECRYPT', { outcome: 'start' });
              const plaintext = await openAegisMessage(body, copyText, {
                messageId,
                conversationId: aegisEnvelope.conversationId,
                senderId,
              });
              if (plaintext !== null) {
                trace('CONTENT_AES_DECRYPT', {
                  outcome: 'ok',
                  blockMs: Date.now() - openStartedAt,
                  conversationId: aegisEnvelope.conversationId,
                });
                const outcome = await buildAuthenticatedOutcomeFromText(plaintext, messageId);
                if (currentUserId && isArchiveBackupEnabled()) {
                  void archiveBubbleForUser({
                    messageId,
                    conversationId: aegisEnvelope.conversationId,
                    userId: currentUserId,
                    plaintext,
                  }).catch(() => false);
                }
                return cacheAndPersist(key, body, outcome, messageId, currentUserId);
              }
            }
          } catch (error) {
            trace('DEVICE_COPY_DECRYPT', {
              outcome: 'error',
              errorCode: error instanceof Error ? error.message : String(error),
            }, 'error');
          }
        }

        if (currentUserId) {
          // The sender's archive is committed atomically with the parent
          // message. It is account-encrypted and can recover an own bubble on
          // a newly linked device even when no historical device capsule was
          // addressed to that installation.
          if (opts.isMe === true && opts.archiveBody) {
            const parentArchive = await decryptArchive(
              opts.archiveBody,
              aegisEnvelope.conversationId,
              currentUserId,
              messageId,
            ).catch(() => null);
            if (parentArchive !== null) {
              trace('ARCHIVE_RECOVERY', { outcome: 'ok', cache: 'network' });
              const outcome = await buildAuthenticatedOutcomeFromText(parentArchive, messageId);
              return cacheAndPersist(key, body, outcome, messageId, currentUserId);
            }
          }

          const archived = await recoverBubbleFromArchive({
            messageId,
            conversationId: aegisEnvelope.conversationId,
            userId: currentUserId,
          }).catch(() => null);
          if (archived !== null) {
            trace('ARCHIVE_RECOVERY', { outcome: 'ok', cache: 'network' });
            const outcome = await buildAuthenticatedOutcomeFromText(archived, messageId);
            return cacheAndPersist(key, body, outcome, messageId, currentUserId);
          }
        }
      }

      trace('PLAINTEXT_RESOLVE', { outcome: 'retry', cache: 'miss', errorCode: 'DEVICE_COPY_UNAVAILABLE' }, 'warn');
      negCache.set(key, Date.now());
      return stickyOrNull(messageId, body);
    })();
    const tracked = promise.finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    inflight.set(key, tracked);
    promise = tracked;
  }

  return promise;
}
