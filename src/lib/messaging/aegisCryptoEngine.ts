import { Capacitor } from '@capacitor/core';
import { getLibSignalCapabilities, libSignalNative, type LibSignalDeviceBundle } from '@/lib/libsignalNative';

export const AEGIS_LIBSIGNAL_COPY_PREFIX = 'aegis2.libsignal.';
export interface AegisCryptoTarget { recipientUserId: string; recipientDeviceId: string; bundle: LibSignalDeviceBundle; }
export function isAegisLibSignalCopy(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(AEGIS_LIBSIGNAL_COPY_PREFIX);
}
export async function assertAegisLibSignalEngine(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') throw new Error('AEGIS_LIBSIGNAL_ANDROID_REQUIRED');
  const capabilities = await getLibSignalCapabilities();
  if (!capabilities.available || !capabilities.pqxdh || !capabilities.kyber1024) throw new Error('AEGIS_LIBSIGNAL_ENGINE_UNAVAILABLE');
}
export async function sealAegisCapsuleWithLibSignal(plaintext: string, target: AegisCryptoTarget): Promise<string> {
  await assertAegisLibSignalEngine();
  const result = await libSignalNative.encryptForDevice({ recipientUserId: target.recipientUserId, recipientDeviceId: target.recipientDeviceId, plaintext, bundle: target.bundle });
  return `${AEGIS_LIBSIGNAL_COPY_PREFIX}${result.messageType}.${result.ciphertextB64}`;
}
export async function openAegisCapsuleWithLibSignal(input: { senderUserId: string; senderDeviceId: string; encryptedBody: string }): Promise<string> {
  await assertAegisLibSignalEngine();
  if (!isAegisLibSignalCopy(input.encryptedBody)) throw new Error('AEGIS_LIBSIGNAL_WIRE_REQUIRED');
  const encoded = input.encryptedBody.slice(AEGIS_LIBSIGNAL_COPY_PREFIX.length);
  const separator = encoded.indexOf('.');
  if (separator <= 0) throw new Error('AEGIS_LIBSIGNAL_WIRE_INVALID');
  const messageType = encoded.slice(0, separator);
  if (messageType !== 'prekey' && messageType !== 'signal') throw new Error('AEGIS_LIBSIGNAL_MESSAGE_TYPE_INVALID');
  const result = await libSignalNative.decryptFromDevice({ senderUserId: input.senderUserId, senderDeviceId: input.senderDeviceId, messageType, ciphertextB64: encoded.slice(separator + 1) });
  return result.plaintext;
}