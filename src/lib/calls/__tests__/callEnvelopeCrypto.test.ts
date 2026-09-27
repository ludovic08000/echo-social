import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadDeviceKxKey: vi.fn(),
  getOrCreateDeviceKxKey: vi.fn(),
}));

vi.mock('@/lib/crypto/deviceKx', () => ({
  loadDeviceKxKey: mocks.loadDeviceKxKey,
  getOrCreateDeviceKxKey: mocks.getOrCreateDeviceKxKey,
}));

import { bufferToBase64 } from '@/lib/crypto/utils';
import { generateCallE2EEKey } from '../callKey';
import { openCallKeyForCurrentDevice, sealCallKeyForDevice } from '../aegisCallProtocol';

const CALL_ID = '018f65a7-8c4a-4bda-9f4f-f449c40f4b40';
const CONVERSATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_CONVERSATION_ID = '223e4567-e89b-42d3-a456-426614174000';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = 'device-one';

describe('Aegis call invitation envelope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('round-trips the media key with identical canonical AAD', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'X25519' } as Algorithm,
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const publicRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
    mocks.loadDeviceKxKey.mockResolvedValue(pair);
    const callKey = generateCallE2EEKey();

    const envelope = await sealCallKeyForDevice({
      callKey,
      callId: CALL_ID,
      conversationId: CONVERSATION_ID,
      recipientUserId: USER_ID,
      recipientDeviceId: DEVICE_ID,
      recipientDevicePublicKey: bufferToBase64(publicRaw),
    });
    await expect(openCallKeyForCurrentDevice({
      envelope,
      callId: CALL_ID,
      conversationId: CONVERSATION_ID,
      recipientUserId: USER_ID,
      recipientDeviceId: DEVICE_ID,
    })).resolves.toBe(callKey);
  });

  it('rejects the same envelope when its conversation binding changes', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'X25519' } as Algorithm,
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const publicRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
    mocks.loadDeviceKxKey.mockResolvedValue(pair);
    const envelope = await sealCallKeyForDevice({
      callKey: generateCallE2EEKey(),
      callId: CALL_ID,
      conversationId: CONVERSATION_ID,
      recipientUserId: USER_ID,
      recipientDeviceId: DEVICE_ID,
      recipientDevicePublicKey: bufferToBase64(publicRaw),
    });

    await expect(openCallKeyForCurrentDevice({
      envelope,
      callId: CALL_ID,
      conversationId: OTHER_CONVERSATION_ID,
      recipientUserId: USER_ID,
      recipientDeviceId: DEVICE_ID,
    })).rejects.toThrow('CALL_INVITATION_INVALID');
  });

  it('rejects a non-canonical public-key encoding even when it decodes to the same bytes', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'X25519' } as Algorithm,
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const publicRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
    mocks.loadDeviceKxKey.mockResolvedValue(pair);
    const envelope = await sealCallKeyForDevice({
      callKey: generateCallE2EEKey(),
      callId: CALL_ID,
      conversationId: CONVERSATION_ID,
      recipientUserId: USER_ID,
      recipientDeviceId: DEVICE_ID,
      recipientDevicePublicKey: bufferToBase64(publicRaw),
    });
    const parts = envelope.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const finalDataIndex = parts[1].length - 2;
    const canonicalIndex = alphabet.indexOf(parts[1][finalDataIndex]);
    parts[1] = `${parts[1].slice(0, finalDataIndex)}${alphabet[canonicalIndex + 1]}=`;

    await expect(openCallKeyForCurrentDevice({
      envelope: parts.join('.'),
      callId: CALL_ID,
      conversationId: CONVERSATION_ID,
      recipientUserId: USER_ID,
      recipientDeviceId: DEVICE_ID,
    })).rejects.toThrow('CALL_INVITATION_INVALID');
  });
});
