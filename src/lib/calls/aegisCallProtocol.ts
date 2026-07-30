import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { getOrCreateDeviceKxKey, loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { fetchVerifiedDeviceList, type SignedDeviceEntry } from '@/lib/crypto/signedDeviceList';
import {
  base64ToBuffer,
  bufferToBase64,
  importOkpPublicKeyFromBase64,
  randomBytes,
} from '@/lib/crypto/utils';
import {
  getCurrentDeviceId,
  hydrateDeviceId,
  isDeviceIdTemporary,
} from '@/lib/messaging/currentDevice';

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

export interface CreatedAegisCall {
  callId: string;
  roomName: string;
}

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
const IV_LENGTH = 12;

function normalizeInvitees(inviteeIds: string[]): string[] {
  return Array.from(new Set(inviteeIds.filter((id) => UUID_RE.test(id)))).sort();
}

export function roomNameForCall(callId: string): string {
  if (!UUID_RE.test(callId)) throw new Error('INVALID_CALL_ID');
  return `call-${callId}`;
}

export function callIdFromRoomName(roomName: string): string | null {
  if (!roomName.startsWith('call-')) return null;
  const callId = roomName.slice(5);
  return UUID_RE.test(callId) ? callId : null;
}

export function buildCallInvitationPlan(
  inviteeIds: string[],
  devicesByUser: ReadonlyMap<string, readonly SignedDeviceEntry[]>,
): AegisCallInvitationPlanEntry[] {
  const normalized = normalizeInvitees(inviteeIds);
  if (normalized.length === 0) throw new Error('CALL_HAS_NO_INVITEES');
  if (normalized.length > 7) throw new Error('CALL_INVITEE_LIMIT_EXCEEDED');

  const plan: AegisCallInvitationPlanEntry[] = [];
  for (const userId of normalized) {
    const trusted = (devicesByUser.get(userId) ?? [])
      .filter((device) => device.isRoutable)
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    if (trusted.length === 0) {
      throw new Error(`CALL_RECIPIENT_HAS_NO_ROUTABLE_DEVICE:${userId}`);
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
  return new hardGlobals.TextEncoder().encode(JSON.stringify({
    protocol: CALL_WIRE,
    callId: args.callId,
    conversationId: args.conversationId,
    recipientUserId: args.recipientUserId,
    recipientDeviceId: args.recipientDeviceId,
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
  const info = new hardGlobals.TextEncoder().encode(
    `forsure-aegis-call-key:${recipientUserId}:${recipientDeviceId}`,
  );
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
  const peerPublicKey = await importOkpPublicKeyFromBase64(
    args.recipientDevicePublicKey,
    'X25519',
    [],
    true,
  );
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
  const key = await deriveEnvelopeKey(
    sharedBits,
    args.callId,
    args.recipientUserId,
    args.recipientDeviceId,
  );
  const iv = randomBytes(IV_LENGTH) as Uint8Array<ArrayBuffer>;
  const ciphertext = await hardCrypto.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: canonicalCallEnvelopeAad(args),
      tagLength: 128,
    },
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
  const parts = args.envelope.split('.');
  if (parts.length !== 4 || parts[0] !== CALL_WIRE) throw new Error('INVALID_CALL_KEY_ENVELOPE');
  const localKx = await loadDeviceKxKey(args.recipientDeviceId, args.recipientUserId);
  if (!localKx) throw new Error('LOCAL_CALL_DEVICE_KEY_MISSING');
  const ephemeralPublic = await importOkpPublicKeyFromBase64(parts[1], 'X25519', [], true);
  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: ephemeralPublic } as Algorithm & { public: CryptoKey },
    localKx.privateKey,
    256,
  );
  const key = await deriveEnvelopeKey(
    sharedBits,
    args.callId,
    args.recipientUserId,
    args.recipientDeviceId,
  );
  const plaintext = await hardCrypto.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(base64ToBuffer(parts[2])),
      additionalData: canonicalCallEnvelopeAad(args),
      tagLength: 128,
    },
    key,
    base64ToBuffer(parts[3]),
  );
  return new hardGlobals.TextDecoder().decode(plaintext);
}

async function currentDeviceId(): Promise<string> {
  const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
  if (!deviceId || isDeviceIdTemporary()) throw new Error('CURRENT_DEVICE_NOT_READY');
  return deviceId;
}

export async function createAegisCall(args: {
  conversationId: string;
  callerId: string;
  inviteeIds: string[];
  callType: AegisCallType;
  callKey: string;
}): Promise<CreatedAegisCall> {
  if (!args.callKey) throw new Error('MISSING_CALL_KEY');
  const inviteeIds = normalizeInvitees(args.inviteeIds).filter((id) => id !== args.callerId);
  const callId = globalThis.crypto.randomUUID();
  const callerDeviceId = await currentDeviceId();
  await getOrCreateDeviceKxKey(callerDeviceId, args.callerId);

  const lists = await Promise.all(inviteeIds.map(async (userId) => {
    const verified = await fetchVerifiedDeviceList(userId);
    if (!verified.signedListPresent) throw new Error(`CALL_RECIPIENT_HAS_NO_SIGNED_DEVICE_LIST:${userId}`);
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

  const { data, error } = await (supabase as any).rpc('aegis_call_create', {
    p_call_id: callId,
    p_conversation_id: args.conversationId,
    p_call_type: args.callType,
    p_caller_device_id: callerDeviceId,
    p_invitee_ids: inviteeIds,
    p_invitations: invitations,
  });
  if (error) throw error;
  if (data?.ok !== true || data?.call_id !== callId) {
    throw new Error(data?.code || 'CALL_CREATE_NOT_AUTHORITATIVE');
  }
  return { callId, roomName: roomNameForCall(callId) };
}

export async function loadCurrentDeviceCallInvitation(callId: string): Promise<OpenedAegisCallInvitation> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('NOT_AUTHENTICATED');
  const deviceId = await currentDeviceId();
  const { data, error } = await (supabase as any).rpc('aegis_call_get_invitation', {
    p_call_id: callId,
    p_device_id: deviceId,
  });
  if (error) throw error;
  if (data?.ok !== true || !data?.encrypted_call_key) throw new Error(data?.code || 'CALL_INVITATION_NOT_FOUND');
  const callKey = await openCallKeyForCurrentDevice({
    envelope: data.encrypted_call_key,
    callId,
    conversationId: data.conversation_id,
    recipientUserId: user.id,
    recipientDeviceId: deviceId,
  });
  return {
    callId,
    conversationId: data.conversation_id,
    callerId: data.caller_id,
    callType: data.call_type,
    isGroup: data.is_group === true,
    roomName: data.room_name,
    callKey,
  };
}

export async function updateAegisCallStatus(
  callId: string,
  status: 'accepted' | 'declined' | 'ended' | 'cancelled',
): Promise<void> {
  const deviceId = await currentDeviceId();
  const { data, error } = await (supabase as any).rpc('aegis_call_update_status', {
    p_call_id: callId,
    p_device_id: deviceId,
    p_status: status,
  });
  if (error) throw error;
  if (data?.ok !== true) throw new Error(data?.code || 'CALL_STATUS_UPDATE_REJECTED');
}

export async function latestAegisCallForCurrentDevice(): Promise<Record<string, unknown> | null> {
  const deviceId = await currentDeviceId();
  const { data, error } = await (supabase as any).rpc('aegis_call_latest_for_device', {
    p_device_id: deviceId,
  });
  if (error) throw error;
  return data?.ok === true ? data.call ?? null : null;
}
