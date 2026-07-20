import { supabase } from '@/integrations/supabase/client';
import type { FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';
import { invalidateFanoutRoute } from '@/lib/messaging/fanoutRouteCache';
import {
  commitFanoutSessionTransaction,
  rollbackFanoutSessionTransaction,
} from '@/lib/messaging/fanoutSessionTransaction';

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
  rebuildCopies: () => Promise<FanoutCopyRow[]>;
};

export type AegisSendResult = {
  data: string | null;
  error: RpcError;
  copies: FanoutCopyRow[];
  retriedStaleRoute: boolean;
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
  if (!error || isExplicitProtocolFailure(error)) return false;
  const text = errorText(error);
  return (
    !error.code ||
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('load failed') ||
    text.includes('timeout') ||
    text.includes('connection')
  );
}

function thrownRpcError(error: unknown): RpcError {
  return {
    code: null,
    message: error instanceof Error ? error.message : String(error ?? 'RPC transport failed'),
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
    const request = Promise.resolve(supabase.rpc('aegis_send_message', {
      p_message_id: args.messageId,
      p_conversation_id: args.conversationId,
      p_body: args.body,
      p_image_url: args.imageUrl,
      p_extra: args.extra as never,
      p_copies: copies as never,
      p_sender_device_id: args.senderDeviceId,
    } as never)) as Promise<RpcResponse>;
    return await Promise.race([request, timeout]);
  } catch (error) {
    return { data: null, error: thrownRpcError(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Aegis atomic send:
 * - the server is authoritative for the current device set;
 * - a stale route is rebuilt and retried exactly once with the same message id;
 * - explicit rejection restores every ratchet snapshot from this attempt;
 * - ambiguous network failures are confirmed once idempotently before returning
 *   and never trigger a blind rollback that could desynchronise a committed send.
 */
export async function sendMessageWithAegisRetry(
  args: SendArguments,
): Promise<AegisSendResult> {
  let copies = args.initialCopies;
  let retriedStaleRoute = false;

  for (let staleAttempt = 0; staleAttempt < 2; staleAttempt += 1) {
    const response = await callAuthoritative(args, copies, SEND_TRANSPORT_TIMEOUT_MS);

    if (!response.error) {
      commitFanoutSessionTransaction(args.messageId);
      return {
        data: (response.data as unknown as string | null) ?? args.messageId,
        error: null,
        copies,
        retriedStaleRoute,
      };
    }

    // A stale/missing route rejection is explicit even when a proxy strips the
    // SQLSTATE. Refresh once: registration or root repair may have completed
    // between local preparation and the atomic RPC.
    if (isAegisDeviceListStale(response.error)) {
      await rollbackFanoutSessionTransaction(args.messageId);
      if (staleAttempt === 0) {
        retriedStaleRoute = true;
        invalidateFanoutRoute(args.conversationId, args.senderUserId);
        copies = await args.rebuildCopies();
        continue;
      }
      return {
        data: null,
        error: response.error,
        copies,
        retriedStaleRoute: true,
      };
    }

    if (isAegisAmbiguousTransportFailure(response.error)) {
      // Confirm the same UUID once. The server RPC is idempotent, so this does
      // not duplicate a message if the first response was merely lost.
      const confirmation = await callAuthoritative(args, copies, SEND_CONFIRM_TIMEOUT_MS);
      if (!confirmation.error) {
        commitFanoutSessionTransaction(args.messageId);
        return {
          data: (confirmation.data as unknown as string | null) ?? args.messageId,
          error: null,
          copies,
          retriedStaleRoute,
        };
      }
      // A second, explicit server rejection resolves the original transport
      // doubt: the idempotent same-UUID confirmation would have returned the
      // committed message if the first call had succeeded. Restore the
      // Ratchet snapshot instead of retaining ciphertext that the server has
      // definitively refused.
      if (!isAegisAmbiguousTransportFailure(confirmation.error)) {
        await rollbackFanoutSessionTransaction(args.messageId);
      }
      // Delivery is now ambiguous. Keep the advanced local state and outbox so
      // a later same-message-id confirmation can resolve it safely. Explicit
      // confirmation failures were rolled back above and are discarded by the
      // outbound engine.
      return {
        data: null,
        error: confirmation.error,
        copies,
        retriedStaleRoute,
      };
    }

    await rollbackFanoutSessionTransaction(args.messageId);
    return {
      data: null,
      error: response.error,
      copies,
      retriedStaleRoute,
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
  };
}
