import { safeUUID } from '@/e2ee-session';
import { assertConversationFingerprintsTrusted } from '@/lib/crypto/fingerprintTracker';
import { savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { createAegisMessage } from '@/lib/messaging/aegisEnvelope';
import {
  isAegisAmbiguousTransportFailure,
  sendMessageWithAegisRetry,
  type AegisBlockedRecipient,
} from '@/lib/messaging/aegisSendRpc';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
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
import { traceE2EE, traceE2EEBlock } from '@/lib/messaging/e2eeTrace';
import { provisionLibsignalDevice } from '@/lib/crypto/libsignalProvisioning';
import { supabase } from '@/integrations/supabase/client';
import { publishSealedSenderWakeups } from '@/lib/messaging/sealedSenderTransport';

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
  deliveryState: 'sent' | 'blocked' | 'partial';
  blockedRecipients: AegisBlockedRecipient[];
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
    text.includes('e2ee_device_registry_unavailable') ||
    text.includes('e2ee_device_registry_invalid') ||
    text.includes('aegis_libsignal_prekey_bundle_unavailable') ||
    text.includes('libsignal_bundle_required') ||
    text.includes('device_route_not_ready')
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

function isMessageIdConflict(error: unknown): boolean {
  if (errorMessage(error).toLowerCase().includes('message_id_conflict')) return true;
  try {
    return JSON.stringify(error).toLowerCase().includes('message_id_conflict');
  } catch {
    return false;
  }
}

async function isExactCommittedMessage(input: {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  body: string;
  imageUrl: string | null;
}): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, sender_id, conversation_id, body, image_url')
      .eq('id', input.messageId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as {
      id?: unknown;
      sender_id?: unknown;
      conversation_id?: unknown;
      body?: unknown;
      image_url?: unknown;
    };
    return row.id === input.messageId &&
      row.sender_id === input.senderUserId &&
      row.conversation_id === input.conversationId &&
      row.body === input.body &&
      (row.image_url ?? null) === input.imageUrl;
  } catch {
    return false;
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
  const traceBlock = <T>(stage: string, operation: () => Promise<T>) => traceE2EEBlock({
    direction: 'send',
    component: 'outbound_engine',
    stage,
    traceId,
    messageId,
    conversationId: input.conversationId,
  }, operation);
  trace(resumed ? 'SEND_RESUME' : 'SEND_CREATED');
  const readyDevice = await traceBlock(
    'DEVICE_READINESS',
    () => ensureAegisDeviceReady(input.senderUserId),
  );
  // Invariant : publier les préclés du même moteur et du même appareil que le fanout.
  await traceBlock(
    'LIBSIGNAL_PROVISION',
    () => provisionLibsignalDevice(input.senderUserId, readyDevice.deviceId),
  );
  trace('DEVICE_READY', { deviceId: readyDevice.deviceId });
  let transportPlaintext = resumed?.transportPlaintext ?? input.plaintext;
  let parentBody = isMultiDeviceEnvelopeBody(resumed?.encryptedBody) && resumed?.keyCapsule
    ? resumed.encryptedBody
    : null;
  let keyCapsule = parentBody ? resumed?.keyCapsule ?? null : null;
  const messageExtra = input.extra ?? resumed?.extra;
  const archiveRequired = messageExtra?.view_once !== true;
  let archiveBody = archiveRequired ? resumed?.archiveBody ?? null : null;
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
    archiveBody,
    imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
    extra: messageExtra,
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

  await traceBlock('OUTBOX_DURABLE_WRITE', () => Promise.all([
    persist(),
    savePlaintext(messageId, input.plaintext),
  ]).then(() => undefined));
  trace('OUTBOX_DURABLE');

  // Une seule tentative par conversation ; les copies scellées survivent aux
  // refus réseau sans restaurer un ancien état du ratchet Libsignal.
  const lockQueuedAt = Date.now();
  try {
    return await runAegisConversationJob(
      `${input.senderUserId}:${input.conversationId}:aegis-outbound`,
      async () => {
  trace('SEND_LOCK_ACQUIRED', {
    outcome: 'ok',
    blockMs: Date.now() - lockQueuedAt,
  });
  // Re-check on every attempt, including a retry with durable ciphertext and
  // copies. Otherwise an identity rotation between preparation and retry could
  // bypass the transport gate.
  await traceBlock('TRUST_VERIFY', () => assertConversationFingerprintsTrusted(
    input.senderUserId,
    input.conversationId,
  ));

  if (archiveRequired && !archiveBody) {
    archiveBody = await traceBlock('ARCHIVE_PREPARE', async () => {
      const { encryptArchive } = await import('@/lib/messaging/archive/archiveKey');
      return encryptArchive(
        input.plaintext,
        input.conversationId,
        input.senderUserId,
        messageId,
      );
    });
    // Invariant : un message ordinaire ne quitte jamais le navigateur sans sa
    // copie de récupération chiffrée par la Master Key du compte.
    if (!archiveBody) {
      const error = new Error('AEGIS_ARCHIVE_REQUIRED');
      await persist({
        archiveBody: null,
        status: 'retry_pending',
        lastError: error.message,
      }).catch(() => undefined);
      trace('ARCHIVE_REQUIRED', { errorCode: error.message }, 'error');
      throw error;
    }
    await persist({ archiveBody });
  }

  if (!parentBody) {
    if (utf8ByteLength(input.plaintext) > MAX_INLINE_MESSAGE_BODY_BYTES && !resumed?.transportPlaintext) {
      const prepared = await prepareLongMessageForSend(input.plaintext, messageId);
      transportPlaintext = prepared.transportBody;
      await persist({ transportPlaintext });
    }

    try {
      const preparedMessage = await traceBlock('PARENT_ENCRYPT', () => createAegisMessage({
        messageId,
        conversationId: input.conversationId,
        senderId: input.senderUserId,
        plaintext: transportPlaintext,
        localId,
        traceId,
        createdAt: now,
      }));
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
    const built = await traceBlock('FANOUT_BUILD', () => buildFanoutCopies({
      messageId,
      conversationId: input.conversationId,
      senderUserId: input.senderUserId,
      plaintext: keyCapsule!,
    }));
    if (!built.hasTargets || (built.rows.length === 0 && built.allRecipientsBlocked !== true)) {
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
    trace('FANOUT_READY', {
      targetCount: built.rows.length,
      copyCount: copies.length,
    });
    return { copies, routeVersion };
  };

  try {
    if (copies.length === 0 || !routeVersion) {
      await buildCopies();
    } else {
      await persist({ status: 'sending', preparedCopies: copies, lastError: null });
    }
  } catch (error) {
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
    result = await traceBlock('SERVER_RPC', () => sendMessageWithAegisRetry({
      messageId,
      conversationId: input.conversationId,
      body: parentBody,
      imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
      extra: {
        ...(messageExtra ?? {}),
        body_kind: 'multi_device',
        archive_body: archiveBody,
      },
      senderUserId: input.senderUserId,
      senderDeviceId: readyDevice.deviceId,
      initialCopies: copies,
      routeVersion,
      rebuildCopies: buildCopies,
    }));
  } catch (error) {
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
    const exactCommittedConflict = isMessageIdConflict(result.error) &&
      await isExactCommittedMessage({
        messageId,
        conversationId: input.conversationId,
        senderUserId: input.senderUserId,
        body: parentBody,
        imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
      });
    if (exactCommittedConflict) {
      // A previous attempt committed this exact encrypted message before the
      // archive became durable. The immutable RPC correctly rejects the now
      // richer request; continue only after an exact row match so the common
      // archive finalizer can repair it without creating a duplicate.
      trace('MESSAGE_COMMIT_CONFIRMED_FOR_ARCHIVE_REPAIR', {
        copyCount: copies.length,
      }, 'warn');
      result = { ...result, data: messageId, error: null };
    }
  }

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
  const committedBlockedRecipients = result.blockedRecipients ?? [];
  trace('MESSAGE_COMMITTED', {
    copyCount: copies.length,
    retryCount: result.retriedStaleRoute ? 1 : 0,
  });
  const blockedRecipientIds = new Set(
    committedBlockedRecipients.map((recipient) => recipient.userId),
  );
  const wakeupCopies = copies.filter(
    (copy) => !blockedRecipientIds.has(copy.recipient_user_id),
  );
  // The canonical row and device copies are already committed. Sealed Sender
  // is a metadata-minimised wakeup only; realtime + polling remain the durable
  // delivery path. Run it beside archive finalisation so its 8 s network budget
  // can never keep the sender bubble spinning after an authoritative receipt.
  const sealedSenderTask = traceBlock('SEALED_SENDER_WAKEUP', () => publishSealedSenderWakeups({
    messageId: committedId,
    conversationId: input.conversationId,
    senderUserId: input.senderUserId,
    copies: wakeupCopies,
  }))
    .catch(() => ({ attempted: 0, relayed: 0, failed: 1 }))
    .then((sealedSender) => {
      trace(
        sealedSender.failed === 0 ? 'SEALED_SENDER_RELAYED' : 'SEALED_SENDER_DEFERRED',
        { targetCount: sealedSender.attempted, copyCount: sealedSender.relayed },
        sealedSender.failed === 0 ? 'info' : 'warn',
      );
    });
  void sealedSenderTask;
  // The stable message UUID was cached before the transaction. Only add the
  // ciphertext index after commit; writing the same plaintext row twice wastes
  // IndexedDB work on resource-constrained mobile browsers.
  void savePlaintextForCiphertext(parentBody, input.plaintext).catch(() => undefined);
  if (archiveRequired) {
    const archiveDurable = await traceBlock('ARCHIVE_FINALIZE', async () => {
      const { archiveBubbleForUser } = await import('@/lib/messaging/archive/archiveKey');
      return archiveBubbleForUser({
        messageId: committedId,
        conversationId: input.conversationId,
        userId: input.senderUserId,
        plaintext: input.plaintext,
        ensureParent: true,
      });
    })
      .catch(() => false);
    trace(archiveDurable ? 'ARCHIVE_DURABLE' : 'ARCHIVE_REQUIRED', {}, archiveDurable ? 'info' : 'error');
    if (!archiveDurable) {
      // Le RPC est idempotent : conserver l'outbox permet de vérifier puis
      // finaliser l'archive au prochain essai sans renvoyer un autre message.
      throw new Error('AEGIS_ARCHIVE_DURABILITY_REQUIRED');
    }
  }
  await traceBlock('OUTBOX_DELETE', () => deleteOutboxPayload(localId)).catch(() => undefined);
  trace('SEND_COMPLETE', { copyCount: copies.length });

  return {
    id: committedId,
    parentBody,
    transportPlaintext,
    copies,
    retriedStaleRoute: result.retriedStaleRoute,
    localId,
    traceId,
    deliveryState: result.deliveryState ?? 'sent',
    blockedRecipients: committedBlockedRecipients,
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
    trace('SEND_FAILED', { errorCode: errorMessage(error) }, 'error');
    throw error;
  }
}
