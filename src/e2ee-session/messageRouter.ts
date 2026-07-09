/**
 * Message router — single entry point for decrypting an inbound payload.
 *
 * Never throws. Never returns ciphertext to the UI.
 *
 * Recovery rule:
 * - secure pipeline envelopes are validated first: epoch, replay, sender cert.
 * - legacy encrypted payloads remain supported as fallback.
 * - unreadable payloads are retried a bounded number of times (transient
 *   failures at cold start), then dropped once retries are exhausted.
 */
import {
  RATCHET_PREFIX_V4,
  RATCHET_PREFIX_V5,
  ratchetDecrypt as deviceRatchetDecrypt,
} from '@/lib/crypto/deviceRatchet';
import { validateInboundSecureEnvelope } from '@/lib/crypto/secureMessagePipeline';
import { selfDeviceId } from './deviceRegistry';
import { tryEveryRatchetSession } from './fallbackDecrypt';
import { legacyDecryptByMessageId, isKnownLegacyFormat } from './legacyDecryptRouter';
import { hasSeenMessage, markSeenMessage, makeSeenKey } from './seenMessageStore';
import { noteDecryptFailure, clearDecryptFailure } from './refanoutQueue';
import { noteRetryAttempt, clearRetry } from './pendingRetryStore';
import { pendingMessageQueue } from './pendingMessageQueue';
import {
  loadPlaintext,
  loadPlaintextForCiphertext,
  savePlaintext,
  savePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';
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

async function loadDeliveredPlaintext(messageId: string | undefined, encryptedBody: string): Promise<string | null> {
  if (messageId) {
    const byId = await loadPlaintext(messageId).catch(() => null);
    if (byId) return byId;
  }
  return loadPlaintextForCiphertext(encryptedBody).catch(() => null);
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
    if (input.messageId && unwrapped.errorCode === 'REPLAY_DETECTED') {
      const r = await legacyDecryptByMessageId(input.messageId, input.senderUserId);
      if (r.ok) {
        clearDecryptFailure(input.messageId);
        return r;
      }
    }
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
    const plaintext = await loadDeliveredPlaintext(messageId, encryptedBody);
    return { ok: true, plaintext, via: 'plaintext-cache', errorCode: plaintext ? undefined : 'ALREADY_SEEN' };
  }

  if (
    encryptedBody.startsWith(RATCHET_PREFIX_V5) ||
    encryptedBody.startsWith(RATCHET_PREFIX_V4)
  ) {
    try {
      const pt = await deviceRatchetDecrypt(recipientUserId, me, encryptedBody);
      if (pt !== null) {
        clearDecryptFailure(messageId);
        clearRetry(seenKey);
        markSeenMessage(seenKey);
        return {
          ok: true,
          plaintext: pt,
          via: encryptedBody.startsWith(RATCHET_PREFIX_V5)
            ? 'ratchet-v5'
            : 'ratchet-v4',
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
        clearRetry(seenKey);
        markSeenMessage(seenKey);
        return fb;
      }
    } else if (messageId) {
      const r = await legacyDecryptByMessageId(messageId, senderUserId);
      if (r.ok) {
        clearDecryptFailure(messageId);
        clearRetry(seenKey);
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

    // No refanout dispatched. Rather than dropping once (which permanently
    // loses messages that failed transiently — e.g. ratchet not yet loaded at
    // cold start), leave the envelope UN-seen and retry on the next re-route,
    // up to a bounded number of attempts.
    const retry = noteRetryAttempt(seenKey);
    if (!retry.exhausted) {
      console.debug('[E2EE] decrypt pending retry (ratchet path)', { messageId: messageId || null, attempt: retry.attempts });
      return { ok: false, plaintext: null, errorCode: 'DECRYPT_RETRY_PENDING' };
    }

    markSeenMessage(seenKey);
    return dropUnreadableEnvelope(messageId, 'RATCHET_DECRYPT_DROPPED');
  }

  if (messageId && isKnownLegacyFormat(encryptedBody)) {
    const r = await legacyDecryptByMessageId(messageId, senderUserId);
    if (r.ok) {
      clearDecryptFailure(messageId);
      clearRetry(seenKey);
      markSeenMessage(seenKey);
      return r;
    }

    const refanoutSent = await noteDecryptFailure(messageId, senderUserId);
    if (refanoutSent) {
      return { ok: false, plaintext: null, errorCode: 'REFANOUT_REQUESTED' };
    }

    const retry = noteRetryAttempt(seenKey);
    if (!retry.exhausted) {
      console.debug('[E2EE] decrypt pending retry (legacy path)', { messageId, attempt: retry.attempts });
      return { ok: false, plaintext: null, errorCode: 'DECRYPT_RETRY_PENDING' };
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
  pendingMessageQueue.setRetryHandler(async (envelope) => {
    const input = envelope as Partial<RouteInput>;
    if (!input.encryptedBody || !input.recipientUserId) return false;

    const result = await routeIncoming({
      encryptedBody: input.encryptedBody,
      recipientUserId: input.recipientUserId,
      senderUserId: input.senderUserId,
      messageId: input.messageId,
    });

    if (!result.ok || result.plaintext === null) return false;

    if (input.messageId) await savePlaintext(input.messageId, result.plaintext);
    await savePlaintextForCiphertext(input.encryptedBody, result.plaintext);

    try {
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
    } catch {
      // Non-browser tests.
    }

    return true;
  });
  console.info('[E2EE] decrypt retry enabled; transient failures are retried off the render path');
}
