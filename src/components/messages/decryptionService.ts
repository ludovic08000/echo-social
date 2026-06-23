/**
 * decryptionService — single crypto entry point for message UI.
 *
 * Centralizes every decryption path so `DecryptedMessageBody` stays a pure
 * presentational component. Returns a normalized `DecryptionOutcome` that
 * the UI renders directly without making any further decisions.
 *
 * Resolution order for a single message body:
 *   1. Already-known plaintext (cachedPlaintext / RAM LRU / IndexedDB).
 *   2. Conversation-level decrypt delegate (Double Ratchet primary path).
 *   3. Per-message device-copy fan-out (orthogonal X3DH bootstrap).
 *   4. e2ee-session façade (multi-session ratchet enumeration + queue).
 *   5. Silent — pending queue retries off-screen, UI stays neutral.
 *
 * No string is ever surfaced to the UI on failure — the component decides
 * the neutral placeholder. No console noise on the hot path either.
 */
import { hasMediaKey, parseMediaMessage, buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { isMultiDeviceEnvelopeBody, isSecurePipelineEnvelopeBody, isStrictRatchetEnvelopeBody } from '@/lib/messaging/messageCompatibility';
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

export interface DecryptionOutcome {
  /** Plaintext to show. Includes label only (no embedded media key). */
  text: string;
  /** Optional media key, b64 raw 32B AES-GCM. */
  mediaKeyB64: string | null;
  /** True when the parsed payload asks the UI to render nothing. */
  hidden: boolean;
}

export function looksEncrypted(body: string): boolean {
  return isStrictRatchetEnvelopeBody(body) || isMultiDeviceEnvelopeBody(body) || isSecurePipelineEnvelopeBody(body);
}

/** Bounded LRU plaintext cache shared across mounted bubbles. */
const CACHE_CAP = 500;
class LruMap<K, V> {
  private m = new Map<K, V>();
  constructor(private readonly cap: number) {}
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.cap) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }
  delete(k: K): void { this.m.delete(k); }
}
const cache = new LruMap<string, DecryptionOutcome>(CACHE_CAP);
const inflight = new Map<string, Promise<DecryptionOutcome | null>>();

/**
 * Negative cache — when a decrypt round produces no plaintext we remember
 * the failure for `NEG_TTL_MS` so a re-render storm (50 bubbles re-mount on
 * scroll) does not re-fire the full decrypt cascade for each one.
 *
 * The cache is invalidated by the global `forsure-decrypt-retry` event
 * (dispatched after key restoration / pending-queue success).
 */
const NEG_TTL_MS = 60_000;
const negCache = new Map<string, number>();
function negCacheHit(k: string): boolean {
  const at = negCache.get(k);
  if (at === undefined) return false;
  if (Date.now() - at > NEG_TTL_MS) {
    negCache.delete(k);
    return false;
  }
  return true;
}
export function clearNegativeCache(): void {
  negCache.clear();
}

export function cacheKey(messageId: string | undefined, body: string): string {
  return `${messageId ?? 'noid'}|${body}`;
}

/**
 * Batched sender_id lookup — when many bubbles mount in a single chat
 * scroll, fold all `messages.id → sender_id` queries into one round-trip
 * (≤50 ms window). Removes the N+1 Supabase chatter on the decrypt path.
 */
const BATCH_WINDOW_MS = 50;
const senderBatchPending = new Map<string, Array<(v: string | null) => void>>();
const senderCache = new LruMap<string, string | null>(500);
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
    const map = new Map<string, string | null>();
    for (const row of (data as Array<{ id: string; sender_id: string | null }> | null) ?? []) {
      map.set(row.id, row.sender_id ?? null);
    }
    for (const id of ids) {
      const v = map.get(id) ?? null;
      senderCache.set(id, v);
      (localWaiters.get(id) ?? []).forEach((fn) => fn(v));
    }
  } catch {
    for (const id of ids) {
      (localWaiters.get(id) ?? []).forEach((fn) => fn(null));
    }
  }
}

function getSenderIdBatched(messageId: string): Promise<string | null> {
  const cached = senderCache.get(messageId);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise<string | null>((resolve) => {
    const arr = senderBatchPending.get(messageId) ?? [];
    arr.push(resolve);
    senderBatchPending.set(messageId, arr);
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
  return { text, mediaKeyB64: null, hidden: false };
}

/** Persist plaintext in IndexedDB so cold-starts don't re-decrypt. */
export function persistOutcome(body: string, outcome: DecryptionOutcome, messageId?: string): string {
  const persisted = outcome.mediaKeyB64
    ? buildMediaMessageBody(outcome.text, outcome.mediaKeyB64)
    : outcome.text;
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
    return buildOutcomeFromText(byMessageId);
  }

  const byCiphertext = await loadPlaintextForCiphertext(body).catch(() => null);
  if (!byCiphertext) return null;
  if (messageId) void savePlaintext(messageId, byCiphertext);
  return buildOutcomeFromText(byCiphertext);
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

/**
 * Resolve plaintext for a message body.
 * Returns `null` when no path produced plaintext — the UI must stay silent
 * and wait for `forsure-decrypt-retry`.
 */
export async function resolvePlaintext(opts: {
  body: string;
  messageId?: string;
  isMe?: boolean;
  decrypt: (body: string) => Promise<DecryptResult>;
}): Promise<DecryptionOutcome | null> {
  const { body, messageId, decrypt } = opts;

  // Cleartext shortcut.
  if (!looksEncrypted(body)) return { text: body, mediaKeyB64: null, hidden: false };

  const key = cacheKey(messageId, body);

  const cached = cache.get(key);
  if (cached) return cached;

  const persisted = await loadPersistedOutcome(messageId, body);
  if (persisted) {
    cache.set(key, persisted);
    return persisted;
  }

  // Negative cache — avoid re-running a full decrypt cascade after a recent
  // failure. Bypassed by the retry event which calls clearNegativeCache().
  if (negCacheHit(key)) return null;

  let promise = inflight.get(key);
  if (!promise) {
    promise = (async (): Promise<DecryptionOutcome | null> => {
      let senderId: string | null = null;

      // 1) Conversation-level Double Ratchet (primary). Multi-device-only
      // envelopes intentionally skip this path and resolve via device copies.
      if (!isMultiDeviceEnvelopeBody(body)) {
        try {
          const result = await decrypt(body);
          if (!result.incompatible) {
            if (result.encrypted && !result.verified) {
              negCache.set(key, Date.now());
              return null;
            }
            const outcome = buildOutcomeFromText(result.text);
            return cacheAndPersist(key, body, outcome, messageId);
          }
        } catch {
          /* fall through to alternate paths */
        }
      }

      // 2) Per-message device-copy fan-out.
      // Important: do this even for isMe=true. A message sent from Windows by
      // the same account can be received on iOS as a self-message, but the real
      // plaintext still lives in that iOS device copy.
      if (messageId) {
        senderId = await getSenderIdBatched(messageId);
        if (senderId) {
          const copyText = await tryReadDeviceCopy(messageId, senderId).catch(() => null);
          if (copyText !== null) {
            const outcome = buildOutcomeFromText(copyText);
            return cacheAndPersist(key, body, outcome, messageId);
          }
        }
      }

      // WhatsApp-style multi-device parent envelopes are placeholders: the
      // real ciphertext lives in the per-device copy. Retrying legacy routes
      // here only duplicates refanout requests and can never decrypt the
      // parent body itself.
      if (isMultiDeviceEnvelopeBody(body)) {
        negCache.set(key, Date.now());
        return null;
      }

      // 3) e2ee-session façade (multi-session ratchet + queue).
      if (messageId) {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (user && senderId) {
            const r = await routeIncoming({
              encryptedBody: body,
              recipientUserId: user.id,
              senderUserId: senderId,
              messageId,
            });
            if (r.ok && r.plaintext !== null) {
              const outcome = buildOutcomeFromText(r.plaintext);
              return cacheAndPersist(key, body, outcome, messageId);
            }
          }
        } catch {
          /* swallow — pending queue will retry */
        }
      }

      // 4) Encrypted archive fallback (long-life, wrapped under account master key).
      //    Survives device rotation, cache purge, ghost-device quarantine.
      if (messageId) {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const { data: row } = await supabase
              .from('messages')
              .select('archive_body, conversation_id')
              .eq('id', messageId)
              .maybeSingle();
            const ab = (row as any)?.archive_body as string | null | undefined;
            const convId = (row as any)?.conversation_id as string | null | undefined;
            if (ab && convId && isArchivePayload(ab)) {
              const pt = await decryptArchive(ab, convId, user.id);
              if (pt !== null) {
                const outcome = buildOutcomeFromText(pt);
                return cacheAndPersist(key, body, outcome, messageId);
              }
            }
          }
        } catch {
          /* swallow */
        }
      }

      // 5) Nothing produced plaintext. Mark negative + stay silent.
      negCache.set(key, Date.now());
      return null;
    })();
    inflight.set(key, promise);
    promise.finally(() => inflight.delete(key));
  }

  return promise;
}
