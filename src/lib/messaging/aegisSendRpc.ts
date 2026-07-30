import type { Json } from '@/integrations/supabase/types';
import type { FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import { invalidateFanoutRoute } from '@/lib/messaging/fanoutRouteCache';
import { isAegisDeviceCopyWire } from '@/lib/messaging/messageCompatibility';
import {
  commitFanoutSessionTransaction,
  rollbackFanoutSessionTransaction,
} from '@/lib/messaging/fanoutSessionTransaction';
import { callAegisServer } from '@/lib/messaging/aegisTransport';

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

type AegisCommitReceipt = {
  state: 'committed';
  message_id: string;
  request_digest: string;
  existing: boolean;
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
  const value = data as Partial<AegisCommitReceipt>;
  if (
    value.state !== 'committed' ||
    value.message_id !== expectedMessageId ||
    typeof value.request_digest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.request_digest) ||
    typeof value.existing !== 'boolean'
  ) {
    return null;
  }
  return value as AegisCommitReceipt;
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

function committedMessageId(response: RpcResponse, expectedMessageId: string): string | null {
  if (response.error) return null;
  return parseCommitReceipt(response.data, expectedMessageId)?.message_id ?? null;
}

/**
 * One immutable Aegis transaction per stable message UUID.
 *
 * The server serializes calls for the same UUID and returns a signed-by-state
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

  if (
    copies.length === 0 ||
    copies.some((copy) =>
      copy.message_id !== args.messageId || !isAegisDeviceCopyWire(copy.encrypted_body),
    )
  ) {
    await rollbackFanoutSessionTransaction(args.messageId);
    return {
      data: null,
      error: {
        code: 'AEGIS_CLIENT_DEVICE_COPY_WIRE_REJECTED',
        message: 'Prepared device copy does not use the active Aegis wire format.',
      },
      copies: [],
      retriedStaleRoute: false,
      routeVersion,
    };
  }

  for (let staleAttempt = 0; staleAttempt < 2; staleAttempt += 1) {
    const response = await callAuthoritative(args, copies, SEND_TRANSPORT_TIMEOUT_MS);
    const committedId = committedMessageId(response, args.messageId);

    if (committedId) {
      commitFanoutSessionTransaction(args.messageId);
      return {
        data: committedId,
        error: null,
        copies,
        retriedStaleRoute,
        routeVersion,
      };
    }

    const responseError = response.error ?? unverifiedReceiptError();

    // Route rejection is authoritative only because the server serializes the
    // UUID. It cannot race a still-running call for the same message.
    if (isAegisDeviceListStale(responseError)) {
      await rollbackFanoutSessionTransaction(args.messageId);
      if (staleAttempt === 0) {
        retriedStaleRoute = true;
        invalidateFanoutRoute(args.conversationId, args.senderUserId);
        const rebuilt = await args.rebuildCopies();
        copies = rebuilt.copies;
        routeVersion = rebuilt.routeVersion;
        args = { ...args, routeVersion };
        continue;
      }
      return {
        data: null,
        error: responseError,
        copies,
        retriedStaleRoute: true,
        routeVersion,
      };
    }

    if (isAegisAmbiguousTransportFailure(responseError)) {
      const confirmation = await callAuthoritative(args, copies, SEND_CONFIRM_TIMEOUT_MS);
      const confirmedId = committedMessageId(confirmation, args.messageId);
      if (confirmedId) {
        commitFanoutSessionTransaction(args.messageId);
        return {
          data: confirmedId,
          error: null,
          copies,
          retriedStaleRoute,
          routeVersion,
        };
      }

      const confirmationError = confirmation.error ?? unverifiedReceiptError();
      if (!isAegisAmbiguousTransportFailure(confirmationError)) {
        // The server-side UUID lock guarantees that this rejection happened
        // after any earlier call completed or rolled back.
        await rollbackFanoutSessionTransaction(args.messageId);
      }
      return {
        data: null,
        error: confirmationError,
        copies,
        retriedStaleRoute,
        routeVersion,
      };
    }

    await rollbackFanoutSessionTransaction(args.messageId);
    return {
      data: null,
      error: responseError,
      copies,
      retriedStaleRoute,
      routeVersion,
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
  };
}

export const __test__ = {
  parseCommitReceipt,
};
