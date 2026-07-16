import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  establishDeviceSession,
  ratchetDecryptWithSession,
  ratchetEncrypt,
  clearAllDeviceSessions,
} from '../deviceRatchet';
import { bufferToBase64 } from '../utils';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ALICE_DEVICE = 'alice-device-001';
const BOB_DEVICE = 'bob-device-001';

async function rawPublic(key: CryptoKey): Promise<string> {
  return bufferToBase64(await crypto.subtle.exportKey('raw', key) as ArrayBuffer);
}

describe('Signal protocol hardening', () => {
  beforeEach(async () => {
    await clearAllDeviceSessions();
  });

  it('authenticates the complete device ratchet header for new sessions', async () => {
    const sharedSecret = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const bobInitial = await crypto.subtle.generateKey(
      { name: 'X25519' } as any,
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const bobPrivateJwk = await crypto.subtle.exportKey('jwk', bobInitial.privateKey);
    const bobPublic = await rawPublic(bobInitial.publicKey);

    await establishDeviceSession(ALICE, ALICE_DEVICE, BOB, BOB_DEVICE, sharedSecret, undefined, {
      isInitiator: true,
      peerInitialDhPubB64: bobPublic,
    });
    await establishDeviceSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, sharedSecret, undefined, {
      isInitiator: false,
      selfInitialDhPrivJwk: bobPrivateJwk,
      selfInitialDhPubB64: bobPublic,
    });

    const encrypted = await ratchetEncrypt(ALICE, ALICE_DEVICE, BOB, BOB_DEVICE, 'bonjour');
    expect(encrypted).toMatch(/^x3dh5\.s6/);

    const parts = encrypted!.split('.');
    parts[4] = String(Number(parts[4]) + 1); // PN is header metadata, not ciphertext.
    expect(await ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, parts.join('.'))).toBeNull();

    // Authentication failure must not advance the receiving ratchet state.
    expect(await ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, encrypted!)).toBe('bonjour');
  });
});
