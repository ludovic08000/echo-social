import { safeUUID } from '@/e2ee-session';
import { assertConversationFingerprintsTrusted } from '@/lib/crypto/fingerprintTracker';
import { savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { createAegisMessage } from '@/lib/messaging/aegisEnvelope';
import {
  isAegisAmbiguousTransportFailure,
  sendMessageWithAegisRetry,
} from '@/lib/messaging/aegisSendRpc';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import { rollbackFanoutSessionTransaction } from '@/lib/messaging/fanoutSessionTransaction';
import {
  MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessageForSend,
  utf8ByteLength,
} from '@/lib/messaging/longMessageAttachment';
import {
  isAegisDeviceCopyWire,
  isMultiDeviceEnvelopeBody,
} from '@/lib/messaging/messageCompatibility';
import { buildFanoutCopies, type FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import {
  deleteOutboxPayload,
  putOutboxPayload,
  type OutboxExtra,
  type OutboxPayload,
  type OutboxStatus,
} from '@/lib/messaging/outboxVault';
import { runAegisConversationJob } from '@/lib/messaging/aegisConversationQueue';
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

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
    text.includes('fingerprint changed') ||
    text.includes('fingerprint_changed')
  ) {
    return 'failed_visible';
  }
  if (
    text.includes('e2ee_device') ||
    text.includes('e2ee_sender_device_not_trusted') ||
    text.includes('e2ee_sender_device_required') ||
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

function requestSenderTrustRepair(error: unknown): void {
  const text = errorMessage(error).toLowerCase();
  if (
    !text.includes('e2ee_sender_device_not_trusted') &&
    !text.includes('e2ee_sender_device_required')
  ) {
    return;
  }

  try {
    window.dispatchEvent(new CustomEvent('forsure:device-self-repair-required', {
      detail: { reason: 'sender-route-not-trusted' },
    }));
  } catch {
    // Browser event delivery is best-effort outside the DOM runtime.
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
  const traceStartedAt = Date.now();
  const trace = (
    stage: string,
    details: Partial<Parameters<typeof traceE2EE>[0]> = {},
    level: 'info' | 'warn' | 'error' = 'info',
  ) => traceE2EE({
    direction: 'send',
    stage,
    traceId,
    messageId,
    conversationId: input.conversationId,
    elapsedMs: Date.now() - traceStartedAt,
    ...details,
  }, level);
  trace(resumed ? 'SEND_RESUME' : 'SEND_CREATED');
  const readyDevice = await ensureAegisDeviceReady(input.senderUserId);
  trace('DEVICE_READY', { deviceId: readyDevice.deviceId });
  let transportPlaintext = resumed?.transportPlaintext ?? input.plaintext;
  let parentBody = isMultiDeviceEnvelopeBody(resumed?.encryptedBody) && resumed?.keyCapsule
    ? resumed.encryptedBody
    : null;
  let keyCapsule = parentBody ? resumed?.keyCapsule ?? null : null;
  let archiveBody = resumed?.archiveBody ?? null;
  const archiveBackupEnabled =
    resumed?.archiveBackupEnabled ?? isArchiveBackupEnabled();
  let copies = parentBody
    ? (resumed?.preparedCopies ?? []).filter((copy) =>
        copy.message_id === messageId && isAegisDeviceCopyWire(copy.encrypted_body),
      ) as FanoutCopyRow[]
    : [];
  let routeVersion = parentBody ? resumed?.routeVersion ?? null : null;

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
    routeVersion,
    archiveBackupEnabled,
    archiveBody,
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
  trace('OUTBOX_DURABLE');

  // One lock owns the complete mutable Ratchet transaction: copy creation,
  // authoritative RPC, confirmation and any rollback. Releasing the lock
  // after copy creation would let a later message commit before an earlier
  // rejection rewinds the shared session.
  try {
    return await runAegisConversationJob(
      `${input.senderUserId}:${input.conversationId}:aegis-outbound`,
      async () => {
  trace('SEND_LOCK_ACQUIRED');
  // Re-check on every attempt, including a retry with durable ciphertext and
  // copies. Otherwise an identity rotation between preparation and retry could
  // bypass the transport gate.
  await assertConversationFingerprintsTrusted(
    input.senderUserId,
    input.conversationId,
  );

  if (archiveBackupEnabled && !archiveBody) {
    const { encryptArchive } = await import('@/lib/messaging/archive/archiveKey');
    archiveBody = await encryptArchive(
      input.plaintext,
      input.conversationId,
      input.senderUserId,
      messageId,
    );
    if (!archiveBody) throw new Error('AEGIS_ARCHIVE_PREPARE_FAILED');
    await persist({ archiveBody });
  }

  if (!parentBody) {
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
      await savePlaintext(`aegis-capsule:${messageId}`, keyCapsule);
      copies = [];
      routeVersion = null;
      await persist({
        transportPlaintext,
        encryptedBody: parentBody,
        keyCapsule,
        preparedCopies: [],
        routeVersion: null,
      });
      trace('PARENT_ENCRYPTED');
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

  const buildCopies = async (): Promise<{ copies: FanoutCopyRow[]; routeVersion: string }> => {
    trace('FANOUT_START');
    const built = await buildFanoutCopies({
      messageId,
      conversationId: input.conversationId,
      senderUserId: input.senderUserId,
      plaintext: keyCapsule!,
    });
    if (!built.hasTargets || built.rows.length === 0) {
      throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE');
    }
    if (built.rows.some((row) => !isAegisDeviceCopyWire(row.encrypted_body))) {
      throw new Error('AEGIS_DEVICE_COPY_WIRE_UNSUPPORTED');
    }
    copies = built.rows;
    routeVersion = built.routeVersion;
    if (!routeVersion) throw new Error('E2EE_ROUTE_VERSION_UNAVAILABLE');
    await persist({
      encryptedBody: parentBody,
      keyCapsule,
      transportPlaintext,
      preparedCopies: copies,
      routeVersion,
      status: 'sending',
      lastError: null,
    });
    trace('FANOUT_READY', { targetCount: built.rows.length, copyCount: copies.length });
    return { copies, routeVersion };
  };

  try {
    if (copies.length === 0 || !routeVersion) {
      await buildCopies();
    } else {
      await persist({ status: 'sending', preparedCopies: copies, lastError: null });
    }
  } catch (error) {
    await rollbackFanoutSessionTransaction(messageId).catch(() => 0);
    copies = [];
    requestSenderTrustRepair(error);
    await persist({
      preparedCopies: [],
      status: failureStatus(error),
      lastError: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  }

  let result: Awaited<ReturnType<typeof sendMessageWithAegisRetry>>;
  try {
    trace('SERVER_SEND_START', { copyCount: copies.length });
    result = await sendMessageWithAegisRetry({
      messageId,
      conversationId: input.conversationId,
      body: parentBody,
      imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
      extra: {
        ...(input.extra ?? resumed?.extra ?? {}),
        body_kind: 'multi_device',
        archive_body: archiveBody,
      },
      senderUserId: input.senderUserId,
      senderDeviceId: readyDevice.deviceId,
      initialCopies: copies,
      routeVersion,
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
    trace('SERVER_SEND_FAILED', {
      copyCount: copies.length,
      errorCode: errorMessage(result.error),
    }, 'error');
    const retainedCopies = isAegisAmbiguousTransportFailure(result.error) ? copies : [];
    requestSenderTrustRepair(result.error);
    await persist({
      preparedCopies: retainedCopies,
      status: failureStatus(result.error),
      lastError: errorMessage(result.error),
    });
    throw new Error(errorMessage(result.error));
  }

  const committedId = result.data ?? messageId;
  trace('MESSAGE_COMMITTED', {
    copyCount: copies.length,
    retryCount: result.retriedStaleRoute ? 1 : 0,
  });
  // The stable message UUID was cached before the transaction. Only add the
  // ciphertext index after commit; writing the same plaintext row twice wastes
  // IndexedDB work on resource-constrained mobile browsers.
  void savePlaintextForCiphertext(parentBody, input.plaintext).catch(() => undefined);
  if (archiveBackupEnabled) {
    void import('@/lib/messaging/archive/archiveKey').then(({ archiveBubbleForUser }) =>
      archiveBubbleForUser({
        messageId: committedId,
        conversationId: input.conversationId,
        userId: input.senderUserId,
        plaintext: input.plaintext,
      }),
    ).catch(() => false);
  }
  await deleteOutboxPayload(localId).catch(() => undefined);
  trace('SEND_COMPLETE', { copyCount: copies.length });

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
    // This also covers a cross-tab lock acquisition timeout, which happens before
    // the transaction callback can persist its own failure state.
    await persist({
      status: failureStatus(error),
      lastError: errorMessage(error),
    }).catch(() => undefined);
    trace('SEND_FAILED', { errorCode: errorMessage(error) }, 'error');
    throw error;
  }
}
