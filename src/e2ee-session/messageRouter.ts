/**
 * Message router — single entry point for decrypting an inbound payload.
 *
 * Never throws. Never returns ciphertext to the UI.
 *
 * Important recovery rule:
 * If local E2EE state was wiped or replaced, old encrypted envelopes may be
 * permanently unreadable. In that case we DROP them once instead of queuing
 * endless retries. This mirrors mainstream secure messengers: the app keeps
 * running, future messages work, and unreadable old payloads are shown as
 * unavailable by the UI layer.
 */
import {
  RATCHET_PREFIX_V3,
  RATCHET_PREFIX_V4,
  ratchetDecrypt as deviceRatchetDecrypt,
} from '@/lib/crypto/deviceRatchet';
import { selfDeviceId } from './deviceRegistry';
import { tryEveryRatchetSession } from './fallbackDecrypt';
import { legacyDecryptByMessageId, isKnownLegacyFormat } from './legacyDecryptRouter';
import { hasSeenMessage, markSeenMessage, makeSeenKey } from './seenMessageStore';
import type { DecryptResult, UserId } from './types';

interface RouteInput {
  encryptedBody: string;
  recipientUserId: UserId;
  senderUserId?: UserId;
  messageId?: string;
}

function dropUnreadableEnvelope(messageId: string | undefined, errorCode: string): DecryptResult {
  console.warn('[E2EE] unreadable envelope dropped without retry', {
    messageId: messageId || null,
    errorCode,
  });

  return {
    ok: false,
    plaintext: null,
    errorCode,
  };
}

export async function routeIncoming(input: RouteInput): Promise<DecryptResult> {
  const { encryptedBody, recipientUserId, senderUserId, messageId } = input;
  const me = selfDeviceId();

  const seenKey = makeSeenKey({
    messageId,
    ciphertextHash: encryptedBody.slice(0, 16),
  });

  if (hasSeenMessage(seenKey)) {
    return { ok: true, plaintext: null, via: 'plaintext-cache', errorCode: 'ALREADY_SEEN' };
  }

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
      // Continue to fallback probes below.
    }

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

    markSeenMessage(seenKey);
    return dropUnreadableEnvelope(messageId, 'RATCHET_DECRYPT_DROPPED');
  }

  if (messageId && isKnownLegacyFormat(encryptedBody)) {
    const r = await legacyDecryptByMessageId(messageId, senderUserId);
    if (r.ok) {
      markSeenMessage(seenKey);
      return r;
    }

    markSeenMessage(seenKey);
    return dropUnreadableEnvelope(messageId, r.errorCode || 'LEGACY_DECRYPT_DROPPED');
  }

  return { ok: false, plaintext: null, errorCode: 'UNKNOWN_FORMAT' };
}

let wired = false;
export function wirePendingQueue(): void {
  if (wired) return;
  wired = true;
  console.info('[E2EE] pending decrypt retry queue disabled; unreadable envelopes are dropped once');
}
