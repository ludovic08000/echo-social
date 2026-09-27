import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { getOrCreateDeviceKxKey, loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { fetchVerifiedDeviceList, type CanonicalRoutableDevice } from '@/lib/crypto/canonicalDeviceRegistry';
import { base64ToBuffer, bufferToBase64, importOkpPublicKeyFromBase64, randomBytes } from '@/lib/crypto/utils';
import { getCurrentDeviceId, hydrateDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { decodeCallE2EEKey } from './callKey';
import { AegisCallError, normalizeAegisCallError, traceCall } from './callDiagnostics';
import { isAegisCallingEnabled } from './callPolicy';

export type AegisCallType = 'audio' | 'video';
export type AegisCallInvitationStatus = 'pending' | 'accepted' | 'declined';

export interface AegisCallInvitationPlanEntry {
  recipientUserId: string;
  recipientDeviceId: string;
  recipientDevicePublicKey: string;
}

export interface AegisCallInvitationEnvelope {
  recipient_user_id: string;
  recipient_device_id: string;
  encrypted_call_key: string;
}

export interface CreatedAegisCall { callId: string; roomName: string }

export interface OpenedAegisCallInvitation {
  callId: string;
  conversationId: string;
  callerId: string;
  callType: AegisCallType;
  isGroup: boolean;
  roomName: string;
  callKey: string;
}

const CALL_WIRE = 'aegis-call-v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IV_LENGTH = 12;
const X25519_PUBLIC_KEY_LENGTH = 32;
const MIN_ENCRYPTED_KEY_LENGTH = 48;

function asRpcObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isCallType(value: unknown): value is AegisCallType {
  return value === 'audio' || value === 'video';
}

function normalizeInvitees(inviteeIds: string[]): string[] {
  return Array.from(new Set(inviteeIds.filter((id) => UUID_RE.test(id)))).sort();
}

function decodeCanonicalBase64(value: string, expectedLength?: number): ArrayBuffer {
  if (!value || !BASE64_RE.test(value) || value.length > 4096) {
    throw new AegisCallError('CALL_INVITATION_INVALID');
  }
  let decoded: ArrayBuffer;
  try {
    decoded = base64ToBuffer(value);
  } catch (error) {
    throw new AegisCallError('CALL_INVITATION_INVALID', { cause: error });
  }
  if (bufferToBase64(decoded) !== value) {
    throw new AegisCallError('CALL_INVITATION_INVALID');
  }
  if (expectedLength !== undefined && decoded.byteLength !== expectedLength) {
    throw new AegisCallError('CALL_INVITATION_INVALID');
  }
  return decoded;
}

export function roomNameForCall(callId: string): string {
  if (!UUID_RE.test(callId)) throw new AegisCallError('CALL_INVALID_REQUEST');
  return `call-${callId}`;
}

export function callIdFromRoomName(roomName: string): string | null {
  if (!roomName.startsWith('call-')) return null;
  const callId = roomName.slice(5);
  return UUID_RE.test(callId) ? callId : null;
}

export function buildCallInvitationPlan(
  inviteeIds: string[],
  devicesByUser: ReadonlyMap<string, readonly CanonicalRoutableDevice[]>,
): AegisCallInvitationPlanEntry[] {
  const normalized = normalizeInvitees(inviteeIds);
  if (normalized.length === 0) throw new AegisCallError('CALL_HAS_NO_INVITEES');
  if (normalized.length > 7) throw new AegisCallError('CALL_INVITEE_LIMIT_EXCEEDED');

  const plan: AegisCallInvitationPlanEntry[] = [];
  for (const userId of normalized) {
    const trusted = (devicesByUser.get(userId) ?? [])
      .filter((device) => device.isRoutable)
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    if (trusted.length === 0) {
      throw new AegisCallError('CALL_RECIPIENT_HAS_NO_ROUTABLE_DEVICE');
    }
    for (const device of trusted) {
      plan.push({
        recipientUserId: userId,
        recipientDeviceId: device.deviceId,
        recipientDevicePublicKey: device.devicePublicKey,
      });
    }
  }
  return plan;
}

function canonicalCallEnvelopeAad(args: {
  callId: string;
  conversationId: string;
  recipientUserId: string;
  recipientDeviceId: string;
}): Uint8Array<ArrayBuffer> {
  const { callId, conversationId, recipientUserId, recipientDeviceId } = args;
  return new hardGlobals.TextEncoder().encode(JSON.stringify({
    protocol: CALL_WIRE,
    callId,
    conversationId,
    recipientUserId,
    recipientDeviceId,
  })) as Uint8Array<ArrayBuffer>;
}

async function deriveEnvelopeKey(
  sharedBits: ArrayBuffer,
  callId: string,
  recipientUserId: string,
  recipientDeviceId: string,
): Promise<CryptoKey> {
  const saltBytes = new hardGlobals.TextEncoder().encode(`forsure-aegis-call-salt:${callId}`);
  const salt = new Uint8Array(await hardCrypto.digest('SHA-256', saltBytes)) as Uint8Array<ArrayBuffer>;
  const info = new hardGlobals.TextEncoder().encode(`forsure-aegis-call-key:${recipientUserId}:${recipientDeviceId}`);
  const hkdf = await hardCrypto.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return hardCrypto.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealCallKeyForDevice(args: {
  callKey: string;
  callId: string;
  conversationId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  recipientDevicePublicKey: string;
}): Promise<string> {
  if (
    !UUID_RE.test(args.callId)
    || !UUID_RE.test(args.conversationId)
    || !UUID_RE.test(args.recipientUserId)
    || args.recipientDeviceId.length < 8
    || args.recipientDeviceId.length > 200
  ) {
    throw new AegisCallError('CALL_INVALID_REQUEST');
  }
  decodeCallE2EEKey(args.callKey);
  const peerPublicKey = await importOkpPublicKeyFromBase64(args.recipientDevicePublicKey, 'X25519', [], true);
  const ephemeral = await hardCrypto.generateKey(
    { name: 'X25519' } as Algorithm,
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const [ephemeralPublic, sharedBits] = await Promise.all([
    hardCrypto.exportKey('raw', ephemeral.publicKey) as Promise<ArrayBuffer>,
    hardCrypto.deriveBits(
      { name: 'X25519', public: peerPublicKey } as Algorithm & { public: CryptoKey },
      ephemeral.privateKey,
      256,
    ),
  ]);
  const key = await deriveEnvelopeKey(sharedBits, args.callId, args.recipientUserId, args.recipientDeviceId);
  const iv = randomBytes(IV_LENGTH) as Uint8Array<ArrayBuffer>;
  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv, additionalData: canonicalCallEnvelopeAad(args), tagLength: 128 },
    key,
    new hardGlobals.TextEncoder().encode(args.callKey),
  );
  return [
    CALL_WIRE,
    bufferToBase64(ephemeralPublic),
    bufferToBase64(iv.buffer as ArrayBuffer),
    bufferToBase64(ciphertext as ArrayBuffer),
  ].join('.');
}

export async function openCallKeyForCurrentDevice(args: {
  envelope: string;
  callId: string;
  conversationId: string;
  recipientUserId: string;
  recipientDeviceId: string;
}): Promise<string> {
  if (
    args.envelope.length > 8192
    || !UUID_RE.test(args.callId)
    || !UUID_RE.test(args.conversationId)
    || !UUID_RE.test(args.recipientUserId)
    || args.recipientDeviceId.length < 8
    || args.recipientDeviceId.length > 200
  ) {
    throw new AegisCallError('CALL_INVITATION_INVALID');
  }
  const parts = args.envelope.split('.');
  if (parts.length !== 4 || parts[0] !== CALL_WIRE) {
    throw new AegisCallError('CALL_INVITATION_INVALID');
  }
  const ephemeralBytes = decodeCanonicalBase64(parts[1], X25519_PUBLIC_KEY_LENGTH);
  const iv = new Uint8Array(decodeCanonicalBase64(parts[2], IV_LENGTH)) as Uint8Array<ArrayBuffer>;
  const ciphertext = decodeCanonicalBase64(parts[3]);
  if (ciphertext.byteLength < MIN_ENCRYPTED_KEY_LENGTH) {
    throw new AegisCallError('CALL_INVITATION_INVALID');
  }

  const localKx = await loadDeviceKxKey(args.recipientDeviceId, args.recipientUserId);
  if (!localKx) throw new AegisCallError('CALL_CURRENT_DEVICE_NOT_READY');
  const ephemeralPublic = await importOkpPublicKeyFromBase64(
    bufferToBase64(ephemeralBytes),
    'X25519',
    [],
    true,
  );
  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: ephemeralPublic } as Algorithm & { public: CryptoKey },
    localKx.privateKey,
    256,
  );
  const key = await deriveEnvelopeKey(sharedBits, args.callId, args.recipientUserId, args.recipientDeviceId);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv, additionalData: canonicalCallEnvelopeAad(args), tagLength: 128 },
      key,
      ciphertext,
    );
  } catch (error) {
    throw new AegisCallError('CALL_INVITATION_INVALID', { cause: error });
  }
  const callKey = new hardGlobals.TextDecoder().decode(plaintext);
  decodeCallE2EEKey(callKey);
  return callKey;
}

async function currentDeviceId(): Promise<string> {
  const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
  if (!deviceId || isDeviceIdTemporary() || deviceId.length < 8 || deviceId.length > 200) {
    throw new AegisCallError('CALL_CURRENT_DEVICE_NOT_READY');
  }
  return deviceId;
}

export async function createAegisCall(args: {
  conversationId: string;
  callerId: string;
  inviteeIds: string[];
  callType: AegisCallType;
  callKey: string;
}): Promise<CreatedAegisCall> {
  if (!isAegisCallingEnabled()) throw new AegisCallError('CALLS_DISABLED');
  if (!UUID_RE.test(args.conversationId) || !UUID_RE.test(args.callerId) || !isCallType(args.callType)) {
    throw new AegisCallError('CALL_INVALID_REQUEST');
  }
  decodeCallE2EEKey(args.callKey);
  const inviteeIds = normalizeInvitees(args.inviteeIds).filter((id) => id !== args.callerId);
  if (inviteeIds.length === 0) throw new AegisCallError('CALL_HAS_NO_INVITEES');

  const callId = globalThis.crypto.randomUUID();
  const startedAt = Date.now();
  traceCall({ direction: 'outgoing', stage: 'signal', outcome: 'start', callId, conversationId: args.conversationId });
  try {
    const callerDeviceId = await currentDeviceId();
    await getOrCreateDeviceKxKey(callerDeviceId, args.callerId);
    const lists = await Promise.all(inviteeIds.map(async (userId) => {
      const verified = await fetchVerifiedDeviceList(userId);
      if (verified.trusted.length === 0) {
        throw new AegisCallError('CALL_RECIPIENT_HAS_NO_CANONICAL_DEVICE');
      }
      return [userId, verified.trusted] as const;
    }));
    const plan = buildCallInvitationPlan(inviteeIds, new Map(lists));
    const invitations: AegisCallInvitationEnvelope[] = await Promise.all(plan.map(async (entry) => ({
      recipient_user_id: entry.recipientUserId,
      recipient_device_id: entry.recipientDeviceId,
      encrypted_call_key: await sealCallKeyForDevice({
        callKey: args.callKey,
        callId,
        conversationId: args.conversationId,
        recipientUserId: entry.recipientUserId,
        recipientDeviceId: entry.recipientDeviceId,
        recipientDevicePublicKey: entry.recipientDevicePublicKey,
      }),
    })));
    const { data: rawData, error } = await supabase.rpc('aegis_call_create', {
      p_call_id: callId,
      p_conversation_id: args.conversationId,
      p_call_type: args.callType,
      p_caller_device_id: callerDeviceId,
      p_invitee_ids: inviteeIds,
      p_invitations: invitations as unknown as Json,
    });
    const data = asRpcObject(rawData);
    if (error) throw new AegisCallError('CALL_CREATE_REJECTED', { cause: error });
    if (data.ok !== true || data.call_id !== callId) {
      throw normalizeAegisCallError(data.code, 'CALL_CREATE_REJECTED');
    }
    traceCall({
      direction: 'outgoing', stage: 'signal', outcome: 'ok', callId,
      conversationId: args.conversationId, deviceId: callerDeviceId,
      elapsedMs: Date.now() - startedAt,
    });
    return { callId, roomName: roomNameForCall(callId) };
  } catch (error) {
    const normalized = normalizeAegisCallError(error, 'CALL_CREATE_REJECTED');
    traceCall({
      direction: 'outgoing', stage: 'signal', outcome: 'error', callId,
      conversationId: args.conversationId, elapsedMs: Date.now() - startedAt,
      errorCode: normalized.code,
    });
    throw normalized;
  }
}

export async function loadCurrentDeviceCallInvitation(callId: string): Promise<OpenedAegisCallInvitation> {
  if (!isAegisCallingEnabled()) throw new AegisCallError('CALLS_DISABLED');
  if (!UUID_RE.test(callId)) throw new AegisCallError('CALL_INVALID_REQUEST');
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new AegisCallError('CALL_NOT_AUTHENTICATED', { cause: userError });
  const deviceId = await currentDeviceId();
  const startedAt = Date.now();
  traceCall({ direction: 'incoming', stage: 'invitation_open', outcome: 'start', callId, deviceId });
  try {
    const { data: rawData, error } = await supabase.rpc('aegis_call_get_invitation', {
      p_call_id: callId,
      p_device_id: deviceId,
    });
    const data = asRpcObject(rawData);
    if (error) throw new AegisCallError('CALL_INVITATION_NOT_FOUND', { cause: error });
    if (data.ok !== true || typeof data.encrypted_call_key !== 'string') {
      throw normalizeAegisCallError(data.code, 'CALL_INVITATION_NOT_FOUND');
    }
    const conversationId = typeof data.conversation_id === 'string' ? data.conversation_id : '';
    const callerId = typeof data.caller_id === 'string' ? data.caller_id : '';
    const roomName = typeof data.room_name === 'string' ? data.room_name : '';
    const callType = data.call_type;
    if (
      !UUID_RE.test(conversationId)
      || !UUID_RE.test(callerId)
      || !isCallType(callType)
      || roomName !== roomNameForCall(callId)
    ) {
      throw new AegisCallError('CALL_INVITATION_INVALID');
    }
    const callKey = await openCallKeyForCurrentDevice({
      envelope: data.encrypted_call_key,
      callId,
      conversationId,
      recipientUserId: user.id,
      recipientDeviceId: deviceId,
    });
    traceCall({
      direction: 'incoming', stage: 'invitation_open', outcome: 'ok', callId,
      conversationId, deviceId, elapsedMs: Date.now() - startedAt,
    });
    return {
      callId,
      conversationId,
      callerId,
      callType,
      isGroup: data.is_group === true,
      roomName,
      callKey,
    };
  } catch (error) {
    const normalized = normalizeAegisCallError(error, 'CALL_INVITATION_INVALID');
    traceCall({
      direction: 'incoming', stage: 'invitation_open', outcome: 'error', callId,
      deviceId, elapsedMs: Date.now() - startedAt, errorCode: normalized.code,
    });
    throw normalized;
  }
}

export async function updateAegisCallStatus(
  callId: string,
  status: 'accepted' | 'declined' | 'ended' | 'cancelled',
): Promise<void> {
  if (!UUID_RE.test(callId)) throw new AegisCallError('CALL_INVALID_REQUEST');
  const startedAt = Date.now();
  traceCall({ direction: 'local', stage: `status.${status}`, outcome: 'start', callId });
  try {
    const deviceId = await currentDeviceId();
    const { data: rawData, error } = await supabase.rpc('aegis_call_update_status', {
      p_call_id: callId,
      p_device_id: deviceId,
      p_status: status,
    });
    const data = asRpcObject(rawData);
    if (error || data.ok !== true) {
      throw new AegisCallError('CALL_STATUS_UPDATE_FAILED', { cause: error ?? data.code });
    }
    traceCall({
      direction: 'local', stage: `status.${status}`, outcome: 'ok', callId, deviceId,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    const normalized = normalizeAegisCallError(error, 'CALL_STATUS_UPDATE_FAILED');
    traceCall({
      direction: 'local', stage: `status.${status}`, outcome: 'error', callId,
      elapsedMs: Date.now() - startedAt, errorCode: normalized.code,
    });
    throw normalized;
  }
}

export async function latestAegisCallForCurrentDevice(): Promise<Record<string, unknown> | null> {
  if (!isAegisCallingEnabled()) return null;
  const deviceId = await currentDeviceId();
  const { data: rawData, error } = await supabase.rpc('aegis_call_latest_for_device', {
    p_device_id: deviceId,
  });
  const data = asRpcObject(rawData);
  if (error) throw new AegisCallError('CALL_SERVICE_UNAVAILABLE', { cause: error });
  if (data.ok === false) throw normalizeAegisCallError(data.code, 'CALL_SERVICE_UNAVAILABLE');
  return data.ok === true && data.call !== null && typeof data.call === 'object' && !Array.isArray(data.call)
    ? data.call as Record<string, unknown>
    : null;
}
