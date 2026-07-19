import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
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
import { sendMessageWithSesameRetry } from '@/lib/messaging/sesameSendRpc';
import { runSignalConversationJob } from '@/lib/messaging/signalWebConversationQueue';
import {
  SESAME_LITE_PROTOCOL,
  SESAME_LITE_VERSION,
} from '@/lib/messaging/messageCompatibility';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';

export interface SendSesameLiteInput {
  conversationId: string;
  senderUserId: string;
  plaintext: string;
  imageUrl?: string | null;
  extra?: OutboxExtra;
  localId?: string;
  traceId?: string;
  messageId?: string;
}

export interface SendSesameLiteResult {
  id: string;
  parentBody: string;
}

export function buildSesameLiteParentEnvelope(localId: string, traceId?: string): string {
  return JSON.stringify({
    protocol: SESAME_LITE_PROTOCOL,
    version: SESAME_LITE_VERSION,
    encryptionMode: 'multi_device',
    v: PROTOCOL_VERSION,
    ct: 'device_copies',
    ts: Date.now(),
    __lid: localId,
    ...(traceId ? { __tid: traceId } : {}),
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Échec du transport chiffré.');
  }
  return String(error ?? 'Échec du transport chiffré.');
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

export async function sendSesameLiteMessage(
  input: SendSesameLiteInput,
): Promise<SendSesameLiteResult> {
  const now = Date.now();
  const localId = input.localId ?? `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const traceId = input.traceId ?? safeUUID();
  const messageId = input.messageId ?? safeUUID();
  const parentBody = buildSesameLiteParentEnvelope(localId, traceId);
  let transportPlaintext = input.plaintext;
  let copies: FanoutCopyRow[] = [];

  const snapshot: OutboxPayload = {
    localId,
    traceId,
    conversationId: input.conversationId,
    senderId: input.senderUserId,
    plaintext: input.plaintext,
    transportPlaintext,
    encryptedBody: parentBody,
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

  const persistCopies = async (next: FanoutCopyRow[]) => {
    copies = next;
    await putOutboxPayload(input.senderUserId, {
      ...snapshot,
      transportPlaintext,
      preparedCopies: next,
      status: 'sending',
      updatedAt: Date.now(),
    });
  };

  try {
    const built = await runSignalConversationJob(
      `${input.senderUserId}:${input.conversationId}:sesame-lite-fanout`,
      () => buildFanoutCopies({
        messageId,
        conversationId: input.conversationId,
        senderUserId: input.senderUserId,
        plaintext: transportPlaintext,
      }),
    );
    if (!built.hasTargets || built.rows.length === 0) {
      throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE');
    }
    await persistCopies(built.rows);

    const result = await sendMessageWithSesameRetry({
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
          `${input.senderUserId}:${input.conversationId}:sesame-lite-fanout`,
          () => buildFanoutCopies({
            messageId,
            conversationId: input.conversationId,
            senderUserId: input.senderUserId,
            plaintext: transportPlaintext,
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
    await deleteOutboxPayload(localId).catch(() => undefined);
    return { id: result.data ?? messageId, parentBody };
  } catch (error) {
    if (copies.length === 0) {
      await rollbackFanoutSessionTransaction(messageId).catch(() => 0);
      await putOutboxPayload(input.senderUserId, {
        ...snapshot,
        transportPlaintext,
        preparedCopies: [],
        status: 'retry_pending',
        lastError: errorMessage(error),
        updatedAt: Date.now(),
      }).catch(() => undefined);
    }
    throw error;
  }
}
