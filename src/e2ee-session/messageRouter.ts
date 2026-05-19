/**
 * Message router — single entry point for decrypting an inbound payload.
 *
 * Never throws. Never returns ciphertext to the UI.
 *
 * Recovery rule:
 * - secure pipeline envelopes are validated first: epoch, replay, sender cert.
 * - legacy encrypted payloads remain supported as fallback.
 * - unreadable old payloads are dropped once, never retried forever.
 */
import {
  RATCHET_PREFIX_V3,
  RATCHET_PREFIX_V4,
  ratchetDecrypt as deviceRatchetDecrypt,
} from '@/lib/crypto/deviceRatchet';
import { validateInboundSecureEnvelope } from '@/lib/crypto/secureMessagePipeline';
import { selfDeviceId } from './deviceRegistry';
import { tryEveryRatchetSession } from './fallbackDecrypt';
import { legacyDecryptByMessageId, isKnownLegacyFormat } from './legacyDecryptRouter';
import { hasSeenMessage, markSeenMessage, makeSeenKey } from './seenMessageStore';
import { noteDecryptFailure, clearDecryptFailure } from './refanoutQueue';
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

async function unwrapAndValidateInbound(input: RouteInput): Promise<{ body: string; secureValidated: boolean } | { errorCode: string }> {
  try {
    const result = await validateInboundSecureEnvelope({
      localUserId: input.recipientUserId,
      messageId: input.messageId,
      body: input.encryptedBody,
    });

    return {
      body: result.body,
      secureValidated: !!result.meta,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn('[E2EE] secure pipeline validation failed', { messageId: input.messageId, error: msg });
    return { errorCode: msg || 'SECURE_PIPELINE_INVALID' };
  }
}

export async function routeIncoming(input: RouteInput): Promise<DecryptResult> {
  const unwrapped = await unwrapAndValidateInbound(input);
  if ('errorCode' in unwrapped) {
    return dropUnreadableEnvelope(input.messageId, unwrapped.errorCode);
  }

  const encryptedBody = unwrapped.body;
  const { recipientUserId, senderUserId, messageId } = input;
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
        clearDecryptFailure(messageId);
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
        clearDecryptFailure(messageId);
        markSeenMessage(seenKey);
        return fb;
      }
    } else if (messageId) {
      const r = await legacyDecryptByMessageId(messageId, senderUserId);
      if (r.ok) {
        clearDecryptFailure(messageId);
        markSeenMessage(seenKey);
        return r;
      }
    }

    // Persistent failure: ask sender to re-fan-out a fresh device copy.
    // If the request was actually dispatched, DO NOT markSeenMessage —
    // the next realtime/queue resume will retry with the new envelope.
    const refanoutSent = await noteDecryptFailure(messageId, senderUserId);
    if (refanoutSent) {
      return { ok: false, plaintext: null, errorCode: 'REFANOUT_REQUESTED' };
    }

    markSeenMessage(seenKey);
    return dropUnreadableEnvelope(messageId, 'RATCHET_DECRYPT_DROPPED');
  }

  if (messageId && isKnownLegacyFormat(encryptedBody)) {
    const r = await legacyDecryptByMessageId(messageId, senderUserId);
    if (r.ok) {
      clearDecryptFailure(messageId);
      markSeenMessage(seenKey);
      return r;
    }

    const refanoutSent = await noteDecryptFailure(messageId, senderUserId);
    if (refanoutSent) {
      return { ok: false, plaintext: null, errorCode: 'REFANOUT_REQUESTED' };
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
