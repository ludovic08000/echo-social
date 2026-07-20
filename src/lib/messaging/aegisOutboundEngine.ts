import { safeUUID } from '@/e2ee-session';
import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import { savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { createAegisMessage } from '@/lib/messaging/aegisEnvelope';
import {
  isAegisAmbiguousTransportFailure,
  sendMessageWithAegisRetry,
} from '@/lib/messaging/aegisSendRpc';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { rollbackFanoutSessionTransaction } from '@/lib/messaging/fanoutSessionTransaction';
import {
  MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessageForSend,
  utf8ByteLength,
} from '@/lib/messaging/longMessageAttachment';
import { isMultiDeviceEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { buildFanoutCopies, type FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import {
  deleteOutboxPayload,
  putOutboxPayload,
  type OutboxExtra,
  type OutboxPayload,
  type OutboxStatus,
} from '@/lib/messaging/outboxVault';
import { runAegisConversationJob } from '@/lib/messaging/aegisConversationQueue';

const IDENTITY_PREWARM_TIMEOUT_MS = 5_000;

export interface AegisOutboundInput {
  conversationId: string;
  senderUserId: string;
  plaintext: string;
  imageUrl?: string | null;
  extra?: OutboxExtra;
  localId?: string;
  traceId?: string;
  messageId?: string;
  createdAt?: number;
  resumePayload?: OutboxPayload | null;
  onState?: (payload: OutboxPayload) => void | Promise<void>;
}

export interface AegisOutboundResult {
  id: string;
  parentBody: string;
  transportPlaintext: string;
  copies: FanoutCopyRow[];
  retriedStaleRoute: boolean;
  localId: string;
  traceId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Echec du transport chiffre.');
  }
  return String(error ?? 'Echec du transport chiffre.');
}

function failureStatus(error: unknown): OutboxStatus {
  const text = errorMessage(error).toLowerCase();
  if (
    text.includes('401') ||
    text.includes('jwt') ||
    text.includes('not_authenticated') ||
    text.includes('pin unlock required') ||
    text.includes('verification obligatoire') ||
    text.includes('fingerprint changed')
  ) {
    return 'failed_visible';
  }
  if (
    text.includes('e2ee_device') ||
    text.includes('e2ee_participant_route_unavailable') ||
    text.includes('e2ee_no_secure_target') ||
    text.includes('device_prekey_bundle_unavailable') ||
    text.includes('signed_device_list_missing') ||
    text.includes('device_spk_signature_invalid')
  ) {
    return 'waiting_secure_channel';
  }
  return 'retry_pending';
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The only encrypted outbound engine.
 *
 * It owns the stable Aegis parent, the exact device copies, the encrypted
 * outbox and the authoritative atomic RPC. UI hooks may expose different
 * presentation states, but they all execute this transaction.
 */
export async function sendAegisOutboundMessage(
  input: AegisOutboundInput,
): Promise<AegisOutboundResult> {
  const resumed = input.resumePayload ?? null;
  const now = input.createdAt ?? resumed?.createdAt ?? Date.now();
  const localId = input.localId ?? resumed?.localId ?? `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const traceId = input.traceId ?? resumed?.traceId ?? safeUUID();
  const messageId = input.messageId ?? resumed?.reservedServerId ?? safeUUID();
  let transportPlaintext = resumed?.transportPlaintext ?? input.plaintext;
  let parentBody = isMultiDeviceEnvelopeBody(resumed?.encryptedBody) && resumed?.keyCapsule
    ? resumed.encryptedBody
    : null;
  let keyCapsule = parentBody ? resumed?.keyCapsule ?? null : null;
  let copies = parentBody
    ? (resumed?.preparedCopies ?? []).filter((copy) => copy.message_id === messageId) as FanoutCopyRow[]
    : [];

  let snapshot: OutboxPayload = {
    ...(resumed ?? {}),
    localId,
    traceId,
    conversationId: input.conversationId,
    senderId: input.senderUserId,
    plaintext: input.plaintext,
    transportPlaintext,
    encryptedBody: parentBody,
    keyCapsule,
    preparedCopies: copies,
    archiveBody: resumed?.archiveBody ?? null,
    imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
    extra: input.extra ?? resumed?.extra,
    status: 'encrypting',
    retryCount: resumed?.retryCount ?? 0,
    maxRetries: resumed?.maxRetries ?? 5,
    lastError: null,
    createdAt: now,
    updatedAt: Date.now(),
    reservedServerId: messageId,
  };

  const persist = async (patch: Partial<OutboxPayload> = {}) => {
    snapshot = { ...snapshot, ...patch, updatedAt: Date.now() };
    await putOutboxPayload(input.senderUserId, snapshot);
    await input.onState?.(snapshot);
  };

  await Promise.all([
    persist(),
    savePlaintext(messageId, input.plaintext),
  ]);

  // One lock owns the complete mutable Ratchet transaction: copy creation,
  // authoritative RPC, confirmation and any rollback. Releasing the lock
  // after copy creation would let a later message commit before an earlier
  // rejection rewinds the shared session.
  try {
    return await runAegisConversationJob(
      `${input.senderUserId}:${input.conversationId}:aegis-outbound`,
      async () => {
  if (!parentBody) {
    await withTimeout(
      ensureUserE2EEIdentity(input.senderUserId, { waitForMaintenance: false }),
      IDENTITY_PREWARM_TIMEOUT_MS,
      'IDENTITY_PREWARM_TIMEOUT',
    ).catch(() => undefined);

    if (utf8ByteLength(input.plaintext) > MAX_INLINE_MESSAGE_BODY_BYTES && !resumed?.transportPlaintext) {
      const prepared = await prepareLongMessageForSend(input.plaintext, messageId);
      transportPlaintext = prepared.transportBody;
      await persist({ transportPlaintext });
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
      copies = [];
      await persist({
        transportPlaintext,
        encryptedBody: parentBody,
        keyCapsule,
        preparedCopies: [],
      });
    } catch (error) {
      await persist({
        encryptedBody: null,
        keyCapsule: null,
        preparedCopies: [],
        status: failureStatus(error),
        lastError: errorMessage(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  if (!parentBody || !keyCapsule) {
    const error = new Error('AEGIS_DURABLE_PAYLOAD_MISSING');
    await persist({ status: 'retry_pending', lastError: error.message }).catch(() => undefined);
    throw error;
  }

  const buildCopies = async (): Promise<FanoutCopyRow[]> => {
    const built = await buildFanoutCopies({
      messageId,
      conversationId: input.conversationId,
      senderUserId: input.senderUserId,
      plaintext: keyCapsule!,
    });
    if (!built.hasTargets || built.rows.length === 0) {
      throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE');
    }
    copies = built.rows;
    await persist({
      encryptedBody: parentBody,
      keyCapsule,
      transportPlaintext,
      preparedCopies: copies,
      status: 'sending',
      lastError: null,
    });
    return copies;
  };

  try {
    if (copies.length === 0) {
      await buildCopies();
    } else {
      await persist({ status: 'sending', preparedCopies: copies, lastError: null });
    }
  } catch (error) {
    await rollbackFanoutSessionTransaction(messageId).catch(() => 0);
    copies = [];
    await persist({
      preparedCopies: [],
      status: failureStatus(error),
      lastError: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  }

  let result: Awaited<ReturnType<typeof sendMessageWithAegisRetry>>;
  try {
    result = await sendMessageWithAegisRetry({
      messageId,
      conversationId: input.conversationId,
      body: parentBody,
      imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
      extra: { ...(input.extra ?? resumed?.extra ?? {}), body_kind: 'multi_device' },
      senderUserId: input.senderUserId,
      senderDeviceId: getCurrentDeviceId(),
      initialCopies: copies,
      rebuildCopies: buildCopies,
    });
  } catch (error) {
    await rollbackFanoutSessionTransaction(messageId).catch(() => 0);
    copies = [];
    await persist({
      preparedCopies: [],
      status: failureStatus(error),
      lastError: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  }

  copies = result.copies;
  if (result.error) {
    const retainedCopies = isAegisAmbiguousTransportFailure(result.error) ? copies : [];
    await persist({
      preparedCopies: retainedCopies,
      status: failureStatus(result.error),
      lastError: errorMessage(result.error),
    });
    throw new Error(errorMessage(result.error));
  }

  const committedId = result.data ?? messageId;
  // The stable message UUID was cached before the transaction. Only add the
  // ciphertext index after commit; writing the same plaintext row twice wastes
  // IndexedDB work on resource-constrained mobile browsers.
  void savePlaintextForCiphertext(parentBody, input.plaintext).catch(() => undefined);
  void import('@/lib/messaging/archive/archiveKey').then(({ archiveBubbleForUser }) =>
    archiveBubbleForUser({
      messageId: committedId,
      conversationId: input.conversationId,
      userId: input.senderUserId,
      plaintext: input.plaintext,
    }),
  ).catch(() => false);
  await deleteOutboxPayload(localId).catch(() => undefined);

  return {
    id: committedId,
    parentBody,
    transportPlaintext,
    copies,
    retriedStaleRoute: result.retriedStaleRoute,
    localId,
    traceId,
  };
      },
    );
  } catch (error) {
    // This also covers a Web Lock acquisition timeout, which happens before
    // the transaction callback can persist its own failure state.
    await persist({
      status: failureStatus(error),
      lastError: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  }
}
