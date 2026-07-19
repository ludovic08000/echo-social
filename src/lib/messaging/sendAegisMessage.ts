import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { createAegisMessage } from '@/lib/messaging/aegisEnvelope';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { rollbackFanoutSessionTransaction } from '@/lib/messaging/fanoutSessionTransaction';
import {
  MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessageForSend,
  utf8ByteLength,
} from '@/lib/messaging/longMessageAttachment';
import { buildFanoutCopies, type FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import {
  deleteOutboxPayload,
  putOutboxPayload,
  type OutboxExtra,
  type OutboxPayload,
} from '@/lib/messaging/outboxVault';
import { sendMessageWithAegisRetry } from '@/lib/messaging/aegisSendRpc';
import { runSignalConversationJob } from '@/lib/messaging/signalWebConversationQueue';

export interface SendAegisInput {
  conversationId: string;
  senderUserId: string;
  plaintext: string;
  imageUrl?: string | null;
  extra?: OutboxExtra;
  localId?: string;
  traceId?: string;
  messageId?: string;
}

export interface SendAegisResult {
  id: string;
  parentBody: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Echec du transport chiffre.');
  }
  return String(error ?? 'Echec du transport chiffre.');
}

function isAmbiguousTransportError(error: unknown): boolean {
  const text = (error && typeof error === 'object'
    ? Object.values(error as Record<string, unknown>).join(' ')
    : errorMessage(error)).toLowerCase();
  return !text.includes('e2ee_') && !text.includes('permission denied') && (
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('load failed') ||
    text.includes('timeout') ||
    text.includes('connection')
  );
}

/**
 * Aegis v1 send path. The user payload is encrypted exactly once. Double
 * Ratchet fan-out transports only the small content-key capsule to each
 * authenticated device.
 */
export async function sendAegisMessage(
  input: SendAegisInput,
): Promise<SendAegisResult> {
  const now = Date.now();
  const localId = input.localId ?? `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const traceId = input.traceId ?? safeUUID();
  const messageId = input.messageId ?? safeUUID();
  let transportPlaintext = input.plaintext;
  let parentBody: string | null = null;
  let keyCapsule: string | null = null;
  let copies: FanoutCopyRow[] = [];

  const snapshot: OutboxPayload = {
    localId,
    traceId,
    conversationId: input.conversationId,
    senderId: input.senderUserId,
    plaintext: input.plaintext,
    transportPlaintext,
    encryptedBody: null,
    keyCapsule: null,
    preparedCopies: [],
    archiveBody: null,
    imageUrl: input.imageUrl ?? null,
    extra: input.extra,
    status: 'encrypting',
    retryCount: 0,
    maxRetries: 3,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    reservedServerId: messageId,
  };

  await Promise.all([
    putOutboxPayload(input.senderUserId, snapshot),
    savePlaintext(messageId, input.plaintext),
    ensureUserE2EEIdentity(input.senderUserId, { waitForMaintenance: false }),
  ]);

  if (utf8ByteLength(input.plaintext) > MAX_INLINE_MESSAGE_BODY_BYTES) {
    const prepared = await prepareLongMessageForSend(input.plaintext, messageId);
    transportPlaintext = prepared.transportBody;
  }

  try {
    const preparedMessage = await createAegisMessage({
      messageId,
      conversationId: input.conversationId,
      senderId: input.senderUserId,
      plaintext: transportPlaintext,
      localId,
      traceId,
      createdAt: now,
    });
    parentBody = preparedMessage.body;
    keyCapsule = preparedMessage.keyCapsule;

    await putOutboxPayload(input.senderUserId, {
      ...snapshot,
      transportPlaintext,
      encryptedBody: parentBody,
      keyCapsule,
      updatedAt: Date.now(),
    });
  } catch (error) {
    await putOutboxPayload(input.senderUserId, {
      ...snapshot,
      transportPlaintext,
      encryptedBody: null,
      keyCapsule: null,
      preparedCopies: [],
      status: 'retry_pending',
      lastError: errorMessage(error),
      updatedAt: Date.now(),
    }).catch(() => undefined);
    throw error;
  }

  const persistCopies = async (next: FanoutCopyRow[]) => {
    copies = next;
    await putOutboxPayload(input.senderUserId, {
      ...snapshot,
      transportPlaintext,
      encryptedBody: parentBody,
      keyCapsule,
      preparedCopies: next,
      status: 'sending',
      updatedAt: Date.now(),
    });
  };

  try {
    const built = await runSignalConversationJob(
      `${input.senderUserId}:${input.conversationId}:aegis-key-fanout`,
      () => buildFanoutCopies({
        messageId,
        conversationId: input.conversationId,
        senderUserId: input.senderUserId,
        plaintext: keyCapsule!,
      }),
    );
    if (!built.hasTargets || built.rows.length === 0) {
      throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE');
    }
    await persistCopies(built.rows);

    const result = await sendMessageWithAegisRetry({
      messageId,
      conversationId: input.conversationId,
      body: parentBody,
      imageUrl: input.imageUrl ?? null,
      extra: { ...(input.extra ?? {}), body_kind: 'multi_device' },
      senderUserId: input.senderUserId,
      senderDeviceId: getCurrentDeviceId(),
      initialCopies: copies,
      rebuildCopies: async () => {
        const rebuilt = await runSignalConversationJob(
          `${input.senderUserId}:${input.conversationId}:aegis-key-fanout`,
          () => buildFanoutCopies({
            messageId,
            conversationId: input.conversationId,
            senderUserId: input.senderUserId,
            plaintext: keyCapsule!,
          }),
        );
        if (!rebuilt.hasTargets || rebuilt.rows.length === 0) {
          throw new Error('E2EE_DEVICE_LIST_UNAVAILABLE');
        }
        await persistCopies(rebuilt.rows);
        return rebuilt.rows;
      },
    });

    if (result.error) {
      const retainedCopies = isAmbiguousTransportError(result.error) ? result.copies : [];
      await putOutboxPayload(input.senderUserId, {
        ...snapshot,
        transportPlaintext,
        encryptedBody: parentBody,
        keyCapsule,
        preparedCopies: retainedCopies,
        status: 'retry_pending',
        lastError: errorMessage(result.error),
        updatedAt: Date.now(),
      });
      throw new Error(errorMessage(result.error));
    }

    void Promise.all([
      savePlaintext(result.data ?? messageId, input.plaintext),
      savePlaintextForCiphertext(parentBody, input.plaintext),
    ]).catch(() => undefined);
    void import('@/lib/messaging/archive/archiveKey').then(({ archiveBubbleForUser }) =>
      archiveBubbleForUser({
        messageId: result.data ?? messageId,
        conversationId: input.conversationId,
        userId: input.senderUserId,
        plaintext: input.plaintext,
      }),
    ).catch(() => false);
    await deleteOutboxPayload(localId).catch(() => undefined);
    return { id: result.data ?? messageId, parentBody };
  } catch (error) {
    if (copies.length === 0) {
      await rollbackFanoutSessionTransaction(messageId).catch(() => 0);
      await putOutboxPayload(input.senderUserId, {
        ...snapshot,
        transportPlaintext,
        encryptedBody: parentBody,
        keyCapsule,
        preparedCopies: [],
        status: 'retry_pending',
        lastError: errorMessage(error),
        updatedAt: Date.now(),
      }).catch(() => undefined);
    }
    throw error;
  }
}
