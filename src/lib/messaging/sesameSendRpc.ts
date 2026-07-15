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

export type SesameSendResult = {
  data: string | null;
  error: RpcError;
  copies: FanoutCopyRow[];
  retriedStaleRoute: boolean;
  usedCompatibilitySignature: boolean;
};

function errorText(error: RpcError): string {
  if (!error) return '';
  return [error.code, error.message, error.details, error.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isSesameDeviceListStale(error: RpcError): boolean {
  return errorText(error).includes('e2ee_device_list_stale');
}

function isAuthoritativeOverloadMissing(error: RpcError): boolean {
  const text = errorText(error);
  return (
    text.includes('42883') ||
    text.includes('p_sender_device_id') ||
    text.includes('could not find the function') ||
    (text.includes('function public.send_message_with_device_copies') && text.includes('does not exist'))
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

function isAmbiguousTransportFailure(error: RpcError): boolean {
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

async function callAuthoritative(args: SendArguments, copies: FanoutCopyRow[]) {
  return supabase.rpc('send_message_with_device_copies', {
    p_message_id: args.messageId,
    p_conversation_id: args.conversationId,
    p_body: args.body,
    p_image_url: args.imageUrl,
    p_extra: args.extra as never,
    p_copies: copies as never,
    p_sender_device_id: args.senderDeviceId,
  } as never);
}

async function callCompatibility(args: SendArguments, copies: FanoutCopyRow[]) {
  return supabase.rpc('send_message_with_device_copies', {
    p_message_id: args.messageId,
    p_conversation_id: args.conversationId,
    p_body: args.body,
    p_image_url: args.imageUrl,
    p_extra: args.extra as never,
    p_copies: copies as never,
  } as never);
}

/**
 * Sesame §4.1 style send:
 * - the server is authoritative for the current device set;
 * - a stale route is rebuilt and retried exactly once with the same message id;
 * - explicit rejection restores every ratchet snapshot from this attempt;
 * - ambiguous network failures are confirmed once idempotently before returning
 *   and never trigger a blind rollback that could desynchronise a committed send.
 */
export async function sendMessageWithSesameRetry(
  args: SendArguments,
): Promise<SesameSendResult> {
  let copies = args.initialCopies;
  let retriedStaleRoute = false;
  let usedCompatibilitySignature = false;

  for (let staleAttempt = 0; staleAttempt < 2; staleAttempt += 1) {
    let response = await callAuthoritative(args, copies);

    if (response.error && isAuthoritativeOverloadMissing(response.error)) {
      usedCompatibilitySignature = true;
      response = await callCompatibility(args, copies);
    }

    if (!response.error) {
      commitFanoutSessionTransaction(args.messageId);
      return {
        data: (response.data as unknown as string | null) ?? args.messageId,
        error: null,
        copies,
        retriedStaleRoute,
        usedCompatibilitySignature,
      };
    }

    // A stale-list rejection is explicit even when a proxy strips the SQLSTATE.
    if (isSesameDeviceListStale(response.error)) {
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
        usedCompatibilitySignature,
      };
    }

    if (isAmbiguousTransportFailure(response.error)) {
      // Confirm the same UUID once. The server RPC is idempotent, so this does
      // not duplicate a message if the first response was merely lost.
      const confirmation = usedCompatibilitySignature
        ? await callCompatibility(args, copies)
        : await callAuthoritative(args, copies);
      if (!confirmation.error) {
        commitFanoutSessionTransaction(args.messageId);
        return {
          data: (confirmation.data as unknown as string | null) ?? args.messageId,
          error: null,
          copies,
          retriedStaleRoute,
          usedCompatibilitySignature,
        };
      }
      // Delivery is now ambiguous. Keep the advanced local state and outbox so
      // a later same-message-id confirmation can resolve it safely.
      return {
        data: null,
        error: confirmation.error,
        copies,
        retriedStaleRoute,
        usedCompatibilitySignature,
      };
    }

    await rollbackFanoutSessionTransaction(args.messageId);
    return {
      data: null,
      error: response.error,
      copies,
      retriedStaleRoute,
      usedCompatibilitySignature,
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
    usedCompatibilitySignature,
  };
}
