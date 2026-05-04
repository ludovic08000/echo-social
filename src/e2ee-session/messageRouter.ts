/**
 * Message router — single entry point for decrypting an inbound payload.
 *
 * Decision tree:
 *   1. If `encryptedBody` is a known v3/v4 ratchet ciphertext → ratchetDecrypt
 *      (with `tryEveryRatchetSession` fallback).
 *   2. Else if a `messageId` is provided and a `message_device_copies` row
 *      exists for this device → `legacyDecryptByMessageId` (covers X3DH
 *      bootstrap, deviceWrap, and Keychain-rotation).
 *   3. Else if it's a JSON conversation-level envelope → caller delegates
 *      to the existing per-conversation ratchet (we don't duplicate that
 *      decoder here).
 *   4. Else → enqueue in `pendingMessageQueue` (might be out-of-order).
 *
 * Never throws. Never returns ciphertext to the UI.
 */
import {
  RATCHET_PREFIX_V3,
  RATCHET_PREFIX_V4,
  ratchetDecrypt as deviceRatchetDecrypt,
} from '@/lib/crypto/deviceRatchet';
import { selfDeviceId } from './deviceRegistry';
import { tryEveryRatchetSession } from './fallbackDecrypt';
import { legacyDecryptByMessageId, isKnownLegacyFormat } from './legacyDecryptRouter';
import { pendingMessageQueue } from './pendingMessageQueue';
import { hasSeenMessage, markSeenMessage, makeSeenKey } from './seenMessageStore';
import type { DecryptResult, UserId } from './types';

interface RouteInput {
  encryptedBody: string;
  recipientUserId: UserId;
  /** Sender (used by fallbackDecrypt to enumerate peer devices). */
  senderUserId?: UserId;
  /** Original `messages.id` — required for legacy device-copy fallback. */
  messageId?: string;
}

export async function routeIncoming(input: RouteInput): Promise<DecryptResult> {
  const { encryptedBody, recipientUserId, senderUserId, messageId } = input;
  const me = selfDeviceId();

  // Anti-replay key: cheap, RAM-only, cleared after ALL retries succeeded.
  // Hash is just first 16 chars of ciphertext — collisions are harmless
  // because messageId+sessionId already pin the tuple.
  const seenKey = makeSeenKey({
    messageId,
    ciphertextHash: encryptedBody.slice(0, 16),
  });
  if (hasSeenMessage(seenKey)) {
    return { ok: true, plaintext: null, via: 'plaintext-cache', errorCode: 'ALREADY_SEEN' };
  }

  // 1) Ratchet v3/v4 fast path.
  if (
    encryptedBody.startsWith(RATCHET_PREFIX_V4) ||
    encryptedBody.startsWith(RATCHET_PREFIX_V3)
  ) {
    try {
      const pt = await deviceRatchetDecrypt(recipientUserId, me, encryptedBody);
      if (pt !== null) {
        markSeenMessage(seenKey);
        return {
          ok: true,
          plaintext: pt,
          via: encryptedBody.startsWith(RATCHET_PREFIX_V4) ? 'ratchet-v4' : 'ratchet-v3',
        };
      }
    } catch {
      /* fall through to fallback */
    }

    // 1b) Try every known session (real multi-session probe + device-copy
    //     orthogonal path). See fallbackDecrypt.ts.
    if (senderUserId) {
      const fb = await tryEveryRatchetSession(
        recipientUserId,
        senderUserId,
        encryptedBody,
        messageId,
      );
      if (fb.ok) {
        markSeenMessage(seenKey);
        return fb;
      }
    } else if (messageId) {
      const r = await legacyDecryptByMessageId(messageId, senderUserId);
      if (r.ok) {
        markSeenMessage(seenKey);
        return r;
      }
    }

    // 1c) Out-of-order? Enqueue for retry. Do NOT mark seen — a successful
    //     retry must be allowed to deliver later.
    if (messageId) {
      pendingMessageQueue.enqueue(messageId, input);
    }
    return { ok: false, plaintext: null, errorCode: 'RATCHET_DECRYPT_FAILED' };
  }

  // 2) Any other known legacy format with a messageId → router.
  if (messageId && isKnownLegacyFormat(encryptedBody)) {
    const r = await legacyDecryptByMessageId(messageId, senderUserId);
    if (r.ok) {
      markSeenMessage(seenKey);
      return r;
    }
    pendingMessageQueue.enqueue(messageId, input);
    return r;
  }

  return { ok: false, plaintext: null, errorCode: 'UNKNOWN_FORMAT' };
}

/**
 * Wire the pending queue's retry handler to the router itself. Idempotent —
 * call once at app startup.
 */
/**
 * Wire the pending queue's retry handler to the router itself. Idempotent —
 * call once at app startup. On a successful retry we dispatch the existing
 * `forsure-decrypt-retry` event so any mounted `DecryptedMessageBody`
 * re-runs its decryption pipeline and picks up the now-readable plaintext.
 */
let wired = false;
export function wirePendingQueue(): void {
  if (wired) return;
  wired = true;
  pendingMessageQueue.setRetryHandler(async (envelope) => {
    const r = await routeIncoming(envelope as RouteInput);
    if (r.ok && typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
      } catch { /* SSR safe */ }
    }
    return r.ok;
  });
}
