import type { Json } from '@/integrations/supabase/types';
import type { FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import { invalidateFanoutRoute } from '@/lib/messaging/fanoutRouteCache';
import { isAegisDeviceCopyWire } from '@/lib/messaging/messageCompatibility';
import { callAegisServer } from '@/lib/messaging/aegisTransport';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

type RpcError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
} | null;

type RpcResponse = {
  data: unknown;
  error: RpcError;
};

export type AegisBlockedRecipient = {
  userId: string;
  reason: 'recipient_block' | 'sender_block' | 'delivery_policy';
};

type AegisCommitReceipt = {
  state: 'committed';
  message_id: string;
  request_digest: string;
  existing: boolean;
  delivery_state: 'sent' | 'blocked' | 'partial';
  blocked_recipients: AegisBlockedRecipient[];
};

const SEND_TRANSPORT_TIMEOUT_MS = 15_000;
const SEND_CONFIRM_TIMEOUT_MS = 6_000;

type SendArguments = {
  messageId: string;
  conversationId: string;
  body: string;
  imageUrl: string | null;
  extra: Record<string, unknown>;
  senderUserId: string;
  senderDeviceId: string;
  initialCopies: FanoutCopyRow[];
  routeVersion: string;
  rebuildCopies: () => Promise<{ copies: FanoutCopyRow[]; routeVersion: string }>;
};

export type AegisSendResult = {
  data: string | null;
  error: RpcError;
  copies: FanoutCopyRow[];
  retriedStaleRoute: boolean;
  routeVersion: string;
  deliveryState: 'sent' | 'blocked' | 'partial' | null;
  blockedRecipients: AegisBlockedRecipient[];
};

function errorText(error: RpcError): string {
  if (!error) return '';
  return [error.code, error.message, error.details, error.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isAegisDeviceListStale(error: RpcError): boolean {
  const text = errorText(error);
  return (
    text.includes('e2ee_device_list_stale') ||
    text.includes('e2ee_participant_route_unavailable') ||
    text.includes('e2ee_no_secure_target')
  );
}

function isExplicitProtocolFailure(error: RpcError): boolean {
  const text = errorText(error);
  return (
    text.includes('e2ee_') ||
    text.includes('not_authenticated') ||
    text.includes('sender_not_conversation_participant') ||
    text.includes('message_id_conflict') ||
    text.includes('permission denied') ||
    text.includes('row-level security')
  );
}

export function isAegisAmbiguousTransportFailure(error: RpcError): boolean {
  if (!error) return false;
  const code = String(error.code ?? '').toUpperCase();
  if (
    code === 'AEGIS_GATEWAY_UNREACHABLE' ||
    code === 'AEGIS_COMMIT_RECEIPT_UNVERIFIED' ||
    code === 'NETWORK_TRANSPORT_TIMEOUT'
  ) {
    return true;
  }
  if (isExplicitProtocolFailure(error)) return false;
  const text = errorText(error);
  return (
    !error.code ||
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('load failed') ||
    text.includes('timeout') ||
    text.includes('connection') ||
    text.includes('aborterror') ||
    text.includes('aborted')
  );
}

function thrownRpcError(error: unknown): RpcError {
  const message = error instanceof Error ? error.message : String(error ?? 'RPC transport failed');
  return {
    code: message === 'NETWORK_TRANSPORT_TIMEOUT' ? 'NETWORK_TRANSPORT_TIMEOUT' : null,
    message,
    details: null,
    hint: null,
  };
}

function parseCommitReceipt(data: unknown, expectedMessageId: string): AegisCommitReceipt | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as {
    state?: unknown;
    message_id?: unknown;
    request_digest?: unknown;
    existing?: unknown;
    delivery_state?: unknown;
    blocked_recipients?: Array<{ user_id?: unknown; reason?: unknown }>;
  };
  if (
    value.state !== 'committed' ||
    value.message_id !== expectedMessageId ||
    typeof value.request_digest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.request_digest) ||
    typeof value.existing !== 'boolean'
  ) {
    return null;
  }

  const deliveryState = value.delivery_state === 'blocked' || value.delivery_state === 'partial'
    ? value.delivery_state
    : 'sent';
  const blockedRecipients = Array.isArray(value.blocked_recipients)
    ? value.blocked_recipients.flatMap((recipient) => {
        const reason = recipient.reason;
        if (
          typeof recipient.user_id !== 'string'
          || (
            reason !== 'recipient_block'
            && reason !== 'sender_block'
            && reason !== 'delivery_policy'
          )
        ) {
          return [];
        }
        return [{ userId: recipient.user_id, reason } as AegisBlockedRecipient];
      })
    : [];

  return {
    state: 'committed',
    message_id: value.message_id,
    request_digest: value.request_digest,
    existing: value.existing,
    delivery_state: deliveryState,
    blocked_recipients: blockedRecipients,
  };
}

function unverifiedReceiptError(): RpcError {
  return {
    code: 'AEGIS_COMMIT_RECEIPT_UNVERIFIED',
    message: 'The server response did not contain a verifiable Aegis commit receipt.',
    details: null,
    hint: null,
  };
}

async function callAuthoritative(
  args: SendArguments,
  copies: FanoutCopyRow[],
  timeoutMs: number,
): Promise<RpcResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('NETWORK_TRANSPORT_TIMEOUT')), timeoutMs);
  });

  try {
    const request = callAegisServer<unknown>('aegis_send_message', {
      p_message_id: args.messageId,
      p_conversation_id: args.conversationId,
      p_body: args.body,
      p_image_url: args.imageUrl,
      p_extra: args.extra as Json,
      p_copies: copies as unknown as Json,
      p_sender_device_id: args.senderDeviceId,
      p_route_version: args.routeVersion,
    }) as Promise<RpcResponse>;
    return await Promise.race([request, timeout]);
  } catch (error) {
    return { data: null, error: thrownRpcError(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function committedReceipt(response: RpcResponse, expectedMessageId: string): AegisCommitReceipt | null {
  if (response.error) return null;
  return parseCommitReceipt(response.data, expectedMessageId);
}

/**
 * One immutable Aegis transaction per stable message UUID.
 *
 * The server serializes calls for the same UUID and returns an authoritative
 * commit receipt containing the exact stored request digest. A timeout therefore
 * never authorizes a local rollback. The same encrypted request is submitted
 * again and either confirms the committed transaction or returns an explicit
 * rejection after the original database transaction has finished.
 */
export async function sendMessageWithAegisRetry(
  args: SendArguments,
): Promise<AegisSendResult> {
  let copies = args.initialCopies;
  let routeVersion = args.routeVersion;
  let retriedStaleRoute = false;
  const startedAt = Date.now();
  const trace = (stage: string, details: Partial<Parameters<typeof traceE2EE>[0]> = {}, level: 'info' | 'warn' | 'error' = 'info') => traceE2EE({
    direction: 'send',
    component: 'send_rpc',
    stage,
    messageId: args.messageId,
    conversationId: args.conversationId,
    deviceId: args.senderDeviceId,
    elapsedMs: Date.now() - startedAt,
    transport: 'aegis_server',
    ...details,
  }, level);

  if (
    copies.some((copy) =>
      copy.message_id !== args.messageId || !isAegisDeviceCopyWire(copy.encrypted_body),
    )
  ) {
    trace('CLIENT_REQUEST_VALIDATE', { outcome: 'error', copyCount: copies.length, errorCode: 'AEGIS_CLIENT_DEVICE_COPY_WIRE_REJECTED' }, 'error');
    return {
      data: null,
      error: {
        code: 'AEGIS_CLIENT_DEVICE_COPY_WIRE_REJECTED',
        message: 'Prepared device copy does not use the active Aegis wire format.',
      },
      copies: [],
      retriedStaleRoute: false,
      routeVersion,
      deliveryState: null,
      blockedRecipients: [],
    };
  }

  for (let staleAttempt = 0; staleAttempt < 2; staleAttempt += 1) {
    const attemptStartedAt = Date.now();
    trace('RPC_COMMIT_ATTEMPT', { outcome: 'start', retryCount: staleAttempt, copyCount: copies.length });
    const response = await callAuthoritative(args, copies, SEND_TRANSPORT_TIMEOUT_MS);
    const receipt = committedReceipt(response, args.messageId);

    if (receipt) {
      trace('RPC_COMMIT_RECEIPT', { outcome: 'ok', retryCount: staleAttempt, copyCount: copies.length, blockMs: Date.now() - attemptStartedAt });
      return {
        data: receipt.message_id,
        error: null,
        copies,
        retriedStaleRoute,
        routeVersion,
        deliveryState: receipt.delivery_state,
        blockedRecipients: receipt.blocked_recipients,
      };
    }

    const responseError = response.error ?? unverifiedReceiptError();

    // Route rejection is authoritative only because the server serializes the
    // UUID. It cannot race a still-running call for the same message.
    if (isAegisDeviceListStale(responseError)) {
      trace('ROUTE_STALE', { outcome: staleAttempt === 0 ? 'retry' : 'error', retryCount: staleAttempt, errorCode: errorText(responseError) }, 'warn');
      if (staleAttempt === 0) {
        retriedStaleRoute = true;
        invalidateFanoutRoute(args.conversationId, args.senderUserId);
        const rebuilt = await args.rebuildCopies();
        copies = rebuilt.copies;
        routeVersion = rebuilt.routeVersion;
        args = { ...args, routeVersion };
        trace('ROUTE_REBUILT', { outcome: 'ok', copyCount: copies.length, retryCount: 1 });
        continue;
      }
      return {
        data: null,
        error: responseError,
        copies,
        retriedStaleRoute: true,
        routeVersion,
        deliveryState: null,
        blockedRecipients: [],
      };
    }

    if (isAegisAmbiguousTransportFailure(responseError)) {
      trace('RPC_RESULT_AMBIGUOUS', { outcome: 'retry', errorCode: errorText(responseError), blockMs: Date.now() - attemptStartedAt }, 'warn');
      const confirmationStartedAt = Date.now();
      trace('RPC_CONFIRMATION', { outcome: 'start', copyCount: copies.length });
      const confirmation = await callAuthoritative(args, copies, SEND_CONFIRM_TIMEOUT_MS);
      const confirmedReceipt = committedReceipt(confirmation, args.messageId);
      if (confirmedReceipt) {
        trace('RPC_CONFIRMATION', { outcome: 'ok', copyCount: copies.length, blockMs: Date.now() - confirmationStartedAt });
        return {
          data: confirmedReceipt.message_id,
          error: null,
          copies,
          retriedStaleRoute,
          routeVersion,
          deliveryState: confirmedReceipt.delivery_state,
          blockedRecipients: confirmedReceipt.blocked_recipients,
        };
      }

      const confirmationError = confirmation.error ?? unverifiedReceiptError();
      trace('RPC_CONFIRMATION', { outcome: 'error', copyCount: copies.length, blockMs: Date.now() - confirmationStartedAt, errorCode: errorText(confirmationError) }, 'error');
      // Même après refus, conserver les copies scellées sans rembobiner Libsignal.
      return {
        data: null,
        error: confirmationError,
        copies,
        retriedStaleRoute,
        routeVersion,
        deliveryState: null,
        blockedRecipients: [],
      };
    }

    trace('RPC_COMMIT_REJECTED', { outcome: 'error', copyCount: copies.length, errorCode: errorText(responseError), blockMs: Date.now() - attemptStartedAt }, 'error');
    return {
      data: null,
      error: responseError,
      copies,
      retriedStaleRoute,
      routeVersion,
      deliveryState: null,
      blockedRecipients: [],
    };
  }

  return {
    data: null,
    error: {
      code: 'E2EE_DEVICE_LIST_STALE',
      message: 'Device list changed again after the single allowed retry.',
    },
    copies,
    retriedStaleRoute: true,
    routeVersion,
    deliveryState: null,
    blockedRecipients: [],
  };
}

export const __test__ = {
  parseCommitReceipt,
};
