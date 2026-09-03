import { supabase } from '@/integrations/supabase/client';
import { base64ToBuffer, bufferToBase64 } from './utils';
import {
  decryptLibsignalMessage,
  encryptLibsignalMessage,
  establishLibsignalSession,
  type LibsignalAddress,
} from './libsignalPlatformBridge';

export const LIBSIGNAL_WIRE_PREFIX = 'aegis.libsignal.';

function bytes64(bytes: Uint8Array): string {
  return bufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export function encodeLibsignalWire(messageType: number, ciphertext: Uint8Array): string {
  if (!Number.isInteger(messageType) || messageType < 0 || messageType > 255) throw new Error('AEGIS_LIBSIGNAL_TYPE_INVALID');
  return `${LIBSIGNAL_WIRE_PREFIX}${messageType}.${bytes64(ciphertext)}`;
}

export function decodeLibsignalWire(value: string): { messageType: number; ciphertext: Uint8Array } | null {
  if (!value.startsWith(LIBSIGNAL_WIRE_PREFIX)) return null;
  const [rawType, encoded, ...extra] = value.slice(LIBSIGNAL_WIRE_PREFIX.length).split('.');
  const messageType = Number(rawType);
  if (extra.length || !encoded || !Number.isInteger(messageType) || messageType < 0 || messageType > 255) return null;
  try { return { messageType, ciphertext: new Uint8Array(base64ToBuffer(encoded)) }; } catch { return null; }
}

async function deviceNumber(userId: string, deviceId: string): Promise<number> {
  const { data, error } = await (supabase as any).rpc('get_libsignal_device_number', { p_user_id: userId, p_device_id: deviceId });
  const number = Number(data);
  if (error || !Number.isInteger(number) || number < 1 || number > 127) throw new Error('AEGIS_LIBSIGNAL_DEVICE_NUMBER_UNAVAILABLE');
  return number;
}

async function addresses(localUserId: string, localDeviceId: string, remoteUserId: string, remoteDeviceId: string): Promise<{ local: LibsignalAddress; remote: LibsignalAddress }> {
  const [localNumber, remoteNumber] = await Promise.all([deviceNumber(localUserId, localDeviceId), deviceNumber(remoteUserId, remoteDeviceId)]);
  return { local: { userId: localUserId, deviceNumber: localNumber }, remote: { userId: remoteUserId, deviceNumber: remoteNumber } };
}

export async function encryptForLibsignalDevice(args: { conversationId: string; ownerUserId: string; ownerDeviceId: string; remoteUserId: string; remoteDeviceId: string; plaintext: string }): Promise<string> {
  const route = await addresses(args.ownerUserId, args.ownerDeviceId, args.remoteUserId, args.remoteDeviceId);
  const attempt = () => encryptLibsignalMessage({ ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route, plaintext: new TextEncoder().encode(args.plaintext) });
  try {
    const encrypted = await attempt();
    return encodeLibsignalWire(encrypted.messageType, encrypted.ciphertext);
  } catch (error) {
    if (!String(error).includes('SessionNotFound') && !String(error).includes('session not found')) throw error;
  }
  const { data, error } = await (supabase as any).rpc('claim_libsignal_prekey_bundle', {
    p_user_id: args.remoteUserId,
    p_device_id: args.remoteDeviceId,
    p_conversation_id: args.conversationId,
    p_sender_device_id: args.ownerDeviceId,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.public_bundle) throw new Error('AEGIS_LIBSIGNAL_PREKEY_BUNDLE_UNAVAILABLE');
  await establishLibsignalSession({ ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route, bundle: new Uint8Array(base64ToBuffer(row.public_bundle)) });
  const encrypted = await attempt();
  return encodeLibsignalWire(encrypted.messageType, encrypted.ciphertext);
}

export async function decryptFromLibsignalDevice(args: { ownerUserId: string; ownerDeviceId: string; remoteUserId: string; remoteDeviceId: string; payload: string }): Promise<string | null> {
  const encrypted = decodeLibsignalWire(args.payload);
  if (!encrypted) return null;
  const route = await addresses(args.ownerUserId, args.ownerDeviceId, args.remoteUserId, args.remoteDeviceId);
  const plaintext = await decryptLibsignalMessage({ ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route, encrypted });
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}
