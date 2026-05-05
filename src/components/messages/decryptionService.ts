/**
 * decryptionService — safe UI resolver for encrypted message bodies.
 *
 * Important production rule:
 * The UI must not call the conversation ratchet first when a per-device copy can
 * resolve the message. On browsers, local SPK/ratchet state can be missing after
 * storage loss. Calling the responder ratchet in that state triggers
 * `SPK NOT FOUND locally`, then old code purges local ratchet state and shows a
 * red error. WhatsApp-like UX is: device-copy first, silent pending, retry on
 * realtime events.
 */
import { hasMediaKey, parseMediaMessage, buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { isStrictRatchetEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import {
  loadPlaintextForCiphertext,
  savePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import { supabase } from '@/integrations/supabase/client';
import type { DecryptResult } from '@/hooks/useE2EE';

export interface DecryptionOutcome {
  text: string;
  mediaKeyB64: string | null;
  hidden: boolean;
}

export function looksEncrypted(body: string): boolean {
  return isStrictRatchetEnvelopeBody(body);
}

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

const NEG_TTL_MS = 2_000;
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

const senderCache = new LruMap<string, string | null>(500);
async function getSenderId(messageId: string): Promise<string | null> {
  const cached = senderCache.get(messageId);
  if (cached !== undefined) return cached;
  try {
    const { data } = await supabase
      .from('messages')
      .select('sender_id')
      .eq('id', messageId)
      .maybeSingle();
    const senderId = (data as { sender_id?: string } | null)?.sender_id ?? null;
    senderCache.set(messageId, senderId);
    return senderId;
  } catch {
    senderCache.set(messageId, null);
    return null;
  }
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

export function persistOutcome(body: string, outcome: DecryptionOutcome): string {
  const persisted = outcome.mediaKeyB64
    ? buildMediaMessageBody(outcome.text, outcome.mediaKeyB64)
    : outcome.text;
  void savePlaintextForCiphertext(body, persisted);
  return persisted;
}

async function resolveFromDeviceCopy(messageId: string): Promise<string | null> {
  // Try direct self/current-device copy first.
  const direct = await tryReadDeviceCopy(messageId).catch(() => null);
  if (direct !== null) return direct;

  // Then try sender-aware path used for inbound copies.
  const senderId = await getSenderId(messageId);
  if (!senderId) return null;
  return tryReadDeviceCopy(messageId, senderId).catch(() => null);
}

export async function resolvePlaintext(opts: {
  body: string;
  messageId?: string;
  isMe?: boolean;
  decrypt: (body: string) => Promise<DecryptResult>;
}): Promise<DecryptionOutcome | null> {
  const { body, messageId, isMe, decrypt } = opts;

  if (!looksEncrypted(body)) return { text: body, mediaKeyB64: null, hidden: false };

  const key = cacheKey(messageId, body);
  const cached = cache.get(key);
  if (cached) return cached;
  if (negCacheHit(key)) return null;

  let promise = inflight.get(key);
  if (!promise) {
    promise = (async (): Promise<DecryptionOutcome | null> => {
      // 1) Local plaintext store first. This keeps already-read messages visible.
      const stored = await loadPlaintextForCiphertext(body).catch(() => null);
      if (stored) {
        const outcome = buildOutcomeFromText(stored);
        cache.set(key, outcome);
        return outcome;
      }

      // 2) Device-copy fan-out first. This avoids touching the fragile legacy
      // responder ratchet path when local SPK state was lost in another browser.
      if (messageId) {
        const copyText = await resolveFromDeviceCopy(messageId);
        if (copyText !== null) {
          const outcome = buildOutcomeFromText(copyText);
          cache.set(key, outcome);
          void savePlaintextForCiphertext(body, copyText);
          return outcome;
        }
      }

      // 3) Self messages must never attempt inbound ratchet decrypt.
      if (isMe) {
        negCache.set(key, Date.now());
        return null;
      }

      // 4) Last-resort legacy decrypt only for messages without device copies.
      // If this throws SPK/ratchet errors, keep UI silent and wait for retry.
      try {
        const result = await decrypt(body);
        if (!result.incompatible && (!result.encrypted || result.verified)) {
          const outcome = buildOutcomeFromText(result.text);
          cache.set(key, outcome);
          void savePlaintextForCiphertext(body, result.text);
          return outcome;
        }
      } catch {
        // Silent pending. Do not surface red UI, do not leak ciphertext.
      }

      negCache.set(key, Date.now());
      return null;
    })();
    inflight.set(key, promise);
    promise.finally(() => inflight.delete(key));
  }

  return promise;
}
