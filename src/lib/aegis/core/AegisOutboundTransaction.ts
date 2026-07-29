import type {
  AegisOutboundInput,
  AegisOutboundResult,
  FanoutCopyRow,
  OutboxPayload,
} from './types';
import {
  defaultAegisDependencies,
  type AegisRuntimeDependencies,
} from './dependencies';
import {
  errorMessage,
  failureStatus,
  requestSenderTrustRepair,
} from './errors';


/**
 * The only encrypted outbound engine.
 *
 * It owns the stable Aegis parent, the exact device copies, the encrypted
 * outbox and the authoritative atomic RPC. UI hooks may expose different
 * presentation states, but they all execute this transaction.
 */
export async function executeAegisOutboundTransaction(
  input: AegisOutboundInput,
  deps: AegisRuntimeDependencies = defaultAegisDependencies,
): Promise<AegisOutboundResult> {
  const resumed = input.resumePayload ?? null;
  const now = input.createdAt ?? resumed?.createdAt ?? Date.now();
  const localId = input.localId ?? resumed?.localId ?? `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const traceId = input.traceId ?? resumed?.traceId ?? deps.ids.uuid();
  const messageId = input.messageId ?? resumed?.reservedServerId ?? deps.ids.uuid();
  const traceStartedAt = Date.now();
  const trace = (
    stage: string,
    details: Partial<Parameters<AegisRuntimeDependencies['telemetry']['trace']>[0]> = {},
    level: 'info' | 'warn' | 'error' = 'info',
  ) => deps.telemetry.trace({
    direction: 'send',
    stage,
    traceId,
    messageId,
    conversationId: input.conversationId,
    elapsedMs: Date.now() - traceStartedAt,
    ...details,
  }, level);
  trace(resumed ? 'SEND_RESUME' : 'SEND_CREATED');
  const readyDevice = await deps.device.ensureReady(input.senderUserId);
  trace('DEVICE_READY', { deviceId: readyDevice.deviceId });
  let transportPlaintext = resumed?.transportPlaintext ?? input.plaintext;
  let parentBody = deps.compatibility.isMultiDeviceEnvelopeBody(resumed?.encryptedBody) && resumed?.keyCapsule
    ? resumed.encryptedBody
    : null;
  let keyCapsule = parentBody ? resumed?.keyCapsule ?? null : null;
  let archiveBody = resumed?.archiveBody ?? null;
  const archiveBackupEnabled =
    resumed?.archiveBackupEnabled ?? deps.recovery.isArchiveBackupEnabled();
  let copies = parentBody
    ? (resumed?.preparedCopies ?? []).filter((copy) =>
        copy.message_id === messageId && deps.compatibility.isDeviceCopyWire(copy.encrypted_body),
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
    await deps.queue.put(input.senderUserId, snapshot);
    await input.onState?.(snapshot);
  };

  await Promise.all([
    persist(),
    deps.queue.savePlaintext(messageId, input.plaintext),
  ]);
  trace('OUTBOX_DURABLE');

  // One lock owns the complete mutable Ratchet transaction: copy creation,
  // authoritative RPC, confirmation and any rollback. Releasing the lock
  // after copy creation would let a later message commit before an earlier
  // rejection rewinds the shared session.
  try {
    return await deps.queue.runConversationJob(
      `${input.senderUserId}:${input.conversationId}:aegis-outbound`,
      async () => {
  trace('SEND_LOCK_ACQUIRED');
  // Re-check on every attempt, including a retry with durable ciphertext and
  // copies. Otherwise an identity rotation between preparation and retry could
  // bypass the transport gate.
  await deps.device.assertConversationTrusted(
    input.senderUserId,
    input.conversationId,
  );

  if (archiveBackupEnabled && !archiveBody) {
    archiveBody = await deps.recovery.prepareArchiveBody({
      plaintext: input.plaintext,
      conversationId: input.conversationId,
      userId: input.senderUserId,
      messageId,
    });
    if (!archiveBody) throw new Error('AEGIS_ARCHIVE_PREPARE_FAILED');
    await persist({ archiveBody });
  }

  if (!parentBody) {
    if (deps.transport.utf8ByteLength(input.plaintext) > deps.transport.maxInlineBodyBytes && !resumed?.transportPlaintext) {
      const prepared = await deps.transport.prepareLongMessage(input.plaintext, messageId);
      transportPlaintext = prepared.transportBody;
      await persist({ transportPlaintext });
    }

    try {
      const preparedMessage = await deps.crypto.createMessage({
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
      await deps.queue.savePlaintext(`aegis-capsule:${messageId}`, keyCapsule);
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
    const built = await deps.routing.buildCopies({
      messageId,
      conversationId: input.conversationId,
      senderUserId: input.senderUserId,
      plaintext: keyCapsule!,
    });
    if (!built.hasTargets || built.rows.length === 0) {
      throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE');
    }
    if (built.rows.some((row) => !deps.compatibility.isDeviceCopyWire(row.encrypted_body))) {
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
    await deps.routing.rollback(messageId).catch(() => 0);
    copies = [];
    requestSenderTrustRepair(error);
    await persist({
      preparedCopies: [],
      status: failureStatus(error),
      lastError: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  }

  let result: Awaited<ReturnType<AegisRuntimeDependencies['transport']['sendWithRetry']>>;
  try {
    trace('SERVER_SEND_START', { copyCount: copies.length });
    result = await deps.transport.sendWithRetry({
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
    await deps.routing.rollback(messageId).catch(() => 0);
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
    const retainedCopies = deps.transport.isAmbiguousFailure(result.error) ? copies : [];
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
  void deps.queue.savePlaintextForCiphertext(parentBody, input.plaintext).catch(() => undefined);
  if (archiveBackupEnabled) {
    void deps.recovery.archiveCommittedMessage({
      messageId: committedId,
      conversationId: input.conversationId,
      userId: input.senderUserId,
      plaintext: input.plaintext,
    }).catch(() => false);
  }
  await deps.queue.delete(localId).catch(() => undefined);
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
