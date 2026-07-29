import { safeUUID } from '@/e2ee-session';
import { savePlaintext } from '@/lib/crypto/plaintextStore';
import { runAegisConversationJob } from '@/lib/messaging/aegisConversationQueue';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';
import type { FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import {
  deleteOutboxPayload,
  putOutboxPayload,
  type OutboxExtra,
  type OutboxPayload,
  type OutboxStatus,
} from '@/lib/messaging/outboxVault';
import {
  sendServerMessage,
  ServerMessageTransportError,
} from '@/lib/messaging/serverMessageTransport';

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
    return String((error as { message?: unknown }).message ?? 'Échec du transport message.');
  }
  return String(error ?? 'Échec du transport message.');
}

function failureStatus(error: unknown): OutboxStatus {
  if (error instanceof ServerMessageTransportError) {
    if (error.status !== null && error.status < 500) return 'failed_visible';
  }

  const text = errorMessage(error).toLowerCase();
  if (
    text.includes('401')
    || text.includes('403')
    || text.includes('not_authenticated')
    || text.includes('session expir')
    || text.includes('sender_not_conversation_participant')
    || text.includes('message_id_conflict')
    || text.includes('server_message_empty')
    || text.includes('server_message_too_large')
  ) {
    return 'failed_visible';
  }
  return 'retry_pending';
}

/**
 * Compatibility entry point for every existing messaging surface.
 *
 * Historical Aegis envelopes remain readable, but new messages use the
 * idempotent `send_message_server` RPC. A simple send therefore depends only
 * on the authenticated account and conversation membership — never on a
 * DeviceID, Signed PreKey, route version or per-device fan-out.
 */
export async function sendAegisOutboundMessage(
  input: AegisOutboundInput,
): Promise<AegisOutboundResult> {
  const resumed = input.resumePayload ?? null;
  const now = input.createdAt ?? resumed?.createdAt ?? Date.now();
  const localId = input.localId
    ?? resumed?.localId
    ?? `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
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

  trace(resumed ? 'SERVER_SEND_RESUME' : 'SERVER_SEND_CREATED');

  let snapshot: OutboxPayload = {
    ...(resumed ?? {}),
    localId,
    traceId,
    conversationId: input.conversationId,
    senderId: input.senderUserId,
    plaintext: input.plaintext,
    transportPlaintext: input.plaintext,
    // Explicitly discard stale Aegis preparation from a previously blocked
    // outbox row. Server transport never reuses ciphertext or Ratchet state.
    encryptedBody: null,
    keyCapsule: null,
    preparedCopies: [],
    routeVersion: null,
    archiveBackupEnabled: false,
    archiveBody: null,
    imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
    extra: input.extra ?? resumed?.extra,
    status: 'sending',
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
  trace('SERVER_OUTBOX_DURABLE');

  try {
    return await runAegisConversationJob(
      `${input.senderUserId}:${input.conversationId}:server-outbound`,
      async () => {
        trace('SERVER_MESSAGE_RPC_START');

        const committedId = await sendServerMessage({
          messageId,
          conversationId: input.conversationId,
          body: input.plaintext,
          imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
          extra: input.extra ?? resumed?.extra,
        });

        await persist({
          status: 'sent',
          lastError: null,
          encryptedBody: null,
          preparedCopies: [],
          routeVersion: null,
        });

        // The server has acknowledged the stable UUID. Removal is safe because
        // a later duplicate retry would return the same committed message.
        await deleteOutboxPayload(localId).catch(() => undefined);
        trace('SERVER_MESSAGE_COMMITTED');

        return {
          id: committedId,
          parentBody: input.plaintext,
          transportPlaintext: input.plaintext,
          copies: [],
          retriedStaleRoute: false,
          localId,
          traceId,
        };
      },
    );
  } catch (error) {
    const status = failureStatus(error);
    const message = errorMessage(error);
    await persist({
      status,
      lastError: message,
      encryptedBody: null,
      preparedCopies: [],
      routeVersion: null,
    }).catch(() => undefined);
    trace('SERVER_MESSAGE_SEND_FAILED', { errorCode: message.slice(0, 120) }, 'error');
    throw error;
  }
}
