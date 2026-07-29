import { safeUUID } from '@/e2ee-session';
import { supabase } from '@/integrations/supabase/client';
import { assertConversationFingerprintsTrusted } from '@/lib/crypto/fingerprintTracker';
import { base64ToBuffer } from '@/lib/crypto/utils';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import {
  commitFanoutSessionTransaction,
  rollbackFanoutSessionTransaction,
} from '@/lib/messaging/fanoutSessionTransaction';
import { invalidateFanoutRoute } from '@/lib/messaging/fanoutRouteCache';
import { isAegisDeviceCopyWire } from '@/lib/messaging/messageCompatibility';
import {
  buildFanoutCopies,
  tryDecryptDeviceTargetedBody,
  type FanoutCopyRow,
} from '@/lib/messaging/multiDeviceFanout';

const CALL_KEY_PROTOCOL = 'forsure-aegis-call-key';
const CALL_KEY_VERSION = 1;
const CALL_KEY_BYTES = 32;
const CALL_KEY_CAPSULE_MAX_BYTES = 4 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SecureCallKeyCapsule {
  protocol: typeof CALL_KEY_PROTOCOL;
  version: typeof CALL_KEY_VERSION;
  callId: string;
  conversationId: string;
  callerUserId: string;
  callKey: string;
  createdAt: number;
}

export interface StartSecureCallInput {
  conversationId: string;
  callerUserId: string;
  inviteeIds: string[];
  callType: 'audio' | 'video';
  callKeyB64: string;
  isGroup?: boolean;
}

export interface SecureCallStarted {
  callId: string;
  roomId: string;
}

type SecureCallCopyRpcRow = {
  encrypted_body: string;
  sender_user_id: string;
  sender_device_id: string;
  conversation_id: string;
  caller_id: string;
};

type SecureCallRpcResult = {
  ok?: boolean;
  code?: string;
  id?: string;
  room_id?: string;
  status?: string;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBase64Key32(value: string): boolean {
  try {
    return base64ToBuffer(value).byteLength === CALL_KEY_BYTES;
  } catch {
    return false;
  }
}

export function createSecureCallKeyCapsule(input: {
  callId: string;
  conversationId: string;
  callerUserId: string;
  callKeyB64: string;
  createdAt?: number;
}): string {
  if (!UUID_RE.test(input.callId) || !UUID_RE.test(input.conversationId)) {
    throw new Error('CALL_E2EE_INVALID_CONTEXT');
  }
  if (!UUID_RE.test(input.callerUserId) || !isBase64Key32(input.callKeyB64)) {
    throw new Error('CALL_E2EE_INVALID_KEY_CAPSULE');
  }
  return JSON.stringify({
    protocol: CALL_KEY_PROTOCOL,
    version: CALL_KEY_VERSION,
    callId: input.callId,
    conversationId: input.conversationId,
    callerUserId: input.callerUserId,
    callKey: input.callKeyB64,
    createdAt: input.createdAt ?? Date.now(),
  } satisfies SecureCallKeyCapsule);
}

export function parseSecureCallKeyCapsule(
  value: string | null | undefined,
): SecureCallKeyCapsule | null {
  if (!value || !value.startsWith('{') || utf8Length(value) > CALL_KEY_CAPSULE_MAX_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<SecureCallKeyCapsule>;
    if (
      parsed.protocol !== CALL_KEY_PROTOCOL ||
      parsed.version !== CALL_KEY_VERSION ||
      typeof parsed.callId !== 'string' || !UUID_RE.test(parsed.callId) ||
      typeof parsed.conversationId !== 'string' || !UUID_RE.test(parsed.conversationId) ||
      typeof parsed.callerUserId !== 'string' || !UUID_RE.test(parsed.callerUserId) ||
      typeof parsed.callKey !== 'string' || !isBase64Key32(parsed.callKey) ||
      typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt) || parsed.createdAt <= 0
    ) return null;
    return parsed as SecureCallKeyCapsule;
  } catch {
    return null;
  }
}

function uniqueInvitees(inviteeIds: string[], callerUserId: string): string[] {
  const unique = [...new Set(inviteeIds.filter((id) => UUID_RE.test(id) && id !== callerUserId))];
  if (unique.length === 0 || unique.length > 7) {
    throw new Error('CALL_E2EE_INVALID_INVITEE_SET');
  }
  return unique;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'CALL_E2EE_TRANSPORT_FAILED');
  }
  return String(error ?? 'CALL_E2EE_TRANSPORT_FAILED');
}

function isAmbiguousTransportFailure(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('load failed') ||
    text.includes('timeout') ||
    text.includes('connection') ||
    text.includes('aborterror')
  );
}

function isRouteStale(code: string | undefined, error: unknown): boolean {
  const text = `${code ?? ''} ${errorText(error)}`.toLowerCase();
  return text.includes('call_device_route_stale') || text.includes('e2ee_device_list_stale');
}

function rpcCopies(rows: FanoutCopyRow[]) {
  return rows.map((copy) => ({
    recipient_user_id: copy.recipient_user_id,
    recipient_device_id: copy.recipient_device_id,
    sender_device_id: copy.sender_device_id,
    encrypted_body: copy.encrypted_body,
  }));
}

async function createCallRpc(input: {
  callId: string;
  roomId: string;
  conversationId: string;
  inviteeIds: string[];
  callType: 'audio' | 'video';
  senderDeviceId: string;
  copies: FanoutCopyRow[];
}): Promise<{ data: SecureCallRpcResult | null; error: unknown }> {
  const response = await (supabase as any).rpc('create_secure_call_v1', {
    p_call_id: input.callId,
    p_conversation_id: input.conversationId,
    p_room_id: input.roomId,
    p_call_type: input.callType,
    p_invitee_ids: input.inviteeIds,
    p_sender_device_id: input.senderDeviceId,
    p_key_copies: rpcCopies(input.copies),
  });
  return {
    data: (response.data ?? null) as SecureCallRpcResult | null,
    error: response.error ?? null,
  };
}

async function confirmSecureCall(callId: string): Promise<SecureCallRpcResult | null> {
  const { data, error } = await (supabase as any).rpc('get_secure_call_state_v1', {
    p_call_id: callId,
  });
  if (error) throw error;
  return (data ?? null) as SecureCallRpcResult | null;
}

async function prepareCopies(input: {
  callId: string;
  conversationId: string;
  callerUserId: string;
  inviteeIds: string[];
  callKeyB64: string;
}): Promise<FanoutCopyRow[]> {
  const plaintext = createSecureCallKeyCapsule(input);
  const built = await buildFanoutCopies({
    messageId: input.callId,
    conversationId: input.conversationId,
    senderUserId: input.callerUserId,
    plaintext,
    recipientUserIds: input.inviteeIds,
  });
  if (!built.hasTargets || built.rows.length === 0) {
    throw new Error('CALL_E2EE_DEVICE_COPIES_UNAVAILABLE');
  }
  for (const inviteeId of input.inviteeIds) {
    if (!built.rows.some((copy) => copy.recipient_user_id === inviteeId)) {
      throw new Error('CALL_E2EE_RECIPIENT_DEVICE_ROUTE_UNAVAILABLE');
    }
  }
  if (built.rows.some((copy) => !isAegisDeviceCopyWire(copy.encrypted_body))) {
    throw new Error('CALL_E2EE_DEVICE_COPY_WIRE_INVALID');
  }
  return built.rows;
}

export async function startSecureCall(
  input: StartSecureCallInput,
): Promise<SecureCallStarted> {
  if (!UUID_RE.test(input.conversationId) || !UUID_RE.test(input.callerUserId)) {
    throw new Error('CALL_E2EE_INVALID_CONTEXT');
  }
  if (!isBase64Key32(input.callKeyB64)) throw new Error('CALL_E2EE_INVALID_KEY');
  const inviteeIds = uniqueInvitees(input.inviteeIds, input.callerUserId);
  const callId = safeUUID();
  const roomId = safeUUID();
  const readyDevice = await ensureAegisDeviceReady(input.callerUserId);
  await assertConversationFingerprintsTrusted(input.callerUserId, input.conversationId);

  for (let routeAttempt = 0; routeAttempt < 2; routeAttempt += 1) {
    const copies = await prepareCopies({
      callId,
      conversationId: input.conversationId,
      callerUserId: input.callerUserId,
      inviteeIds,
      callKeyB64: input.callKeyB64,
    });

    let lastAmbiguousError: unknown = null;
    for (let transportAttempt = 0; transportAttempt < 3; transportAttempt += 1) {
      const { data, error } = await createCallRpc({
        callId,
        roomId,
        conversationId: input.conversationId,
        inviteeIds,
        callType: input.callType,
        senderDeviceId: readyDevice.deviceId,
        copies,
      });
      if (!error && data?.ok === true) {
        commitFanoutSessionTransaction(callId);
        return { callId: data.id ?? callId, roomId: data.room_id ?? roomId };
      }

      if (isRouteStale(data?.code, error) && routeAttempt === 0) {
        await rollbackFanoutSessionTransaction(callId);
        invalidateFanoutRoute(input.conversationId, input.callerUserId);
        lastAmbiguousError = null;
        break;
      }

      const failure = error ?? new Error(data?.code ?? 'CALL_E2EE_CREATE_REJECTED');
      if (!isAmbiguousTransportFailure(failure)) {
        await rollbackFanoutSessionTransaction(callId);
        throw failure instanceof Error ? failure : new Error(errorText(failure));
      }
      lastAmbiguousError = failure;
      await new Promise((resolve) => setTimeout(resolve, 250 * (transportAttempt + 1)));
    }

    if (lastAmbiguousError) {
      try {
        const confirmed = await confirmSecureCall(callId);
        if (confirmed?.ok === true || confirmed?.id === callId) {
          commitFanoutSessionTransaction(callId);
          return { callId, roomId: confirmed.room_id ?? roomId };
        }
        await rollbackFanoutSessionTransaction(callId);
      } catch {
        // The route has advanced by one key. A later Double Ratchet message can
        // safely skip that lost key; never risk rewinding a call that committed.
      }
      throw new Error(`CALL_E2EE_CONFIRMATION_PENDING:${errorText(lastAmbiguousError)}`);
    }
  }

  throw new Error('CALL_E2EE_DEVICE_ROUTE_STALE');
}

export async function decryptSecureCallKeyForCurrentDevice(input: {
  callId: string;
  conversationId: string;
  currentUserId: string;
  expectedCallerId: string;
}): Promise<string> {
  const readyDevice = await ensureAegisDeviceReady(input.currentUserId);
  const { data, error } = await (supabase as any).rpc('get_secure_call_device_key_v1', {
    p_call_id: input.callId,
    p_device_id: readyDevice.deviceId,
  });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const row = rows[0] as SecureCallCopyRpcRow | undefined;
  if (!row || row.sender_user_id !== input.expectedCallerId) {
    throw new Error('CALL_E2EE_DEVICE_COPY_UNAVAILABLE');
  }
  if (
    row.conversation_id !== input.conversationId ||
    row.caller_id !== input.expectedCallerId ||
    !isAegisDeviceCopyWire(row.encrypted_body)
  ) {
    throw new Error('CALL_E2EE_DEVICE_COPY_CONTEXT_INVALID');
  }

  const plaintext = await tryDecryptDeviceTargetedBody(
    row,
    input.currentUserId,
    readyDevice.deviceId,
  );
  const capsule = parseSecureCallKeyCapsule(plaintext);
  if (
    !capsule ||
    capsule.callId !== input.callId ||
    capsule.conversationId !== input.conversationId ||
    capsule.callerUserId !== input.expectedCallerId
  ) {
    throw new Error('CALL_E2EE_KEY_CAPSULE_INVALID');
  }
  return capsule.callKey;
}

export const __test__ = {
  protocol: CALL_KEY_PROTOCOL,
  version: CALL_KEY_VERSION,
  keyBytes: CALL_KEY_BYTES,
  isAmbiguousTransportFailure,
};
