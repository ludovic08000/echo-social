import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  clearAllDeviceSessions,
  establishDeviceSession,
  ratchetDecryptWithSession,
  ratchetEncrypt,
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

  it('authenticates the complete device ratchet header without advancing state on failure', async () => {
    const sharedSecret = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const bobInitial = await crypto.subtle.generateKey(
      { name: 'X25519' } as Algorithm,
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const bobPrivateJwk = await crypto.subtle.exportKey('jwk', bobInitial.privateKey);
    const bobPublic = await rawPublic(bobInitial.publicKey);

    const sessionId = await establishDeviceSession(
      ALICE,
      ALICE_DEVICE,
      BOB,
      BOB_DEVICE,
      sharedSecret,
      undefined,
      {
        isInitiator: true,
        peerInitialDhPubB64: bobPublic,
      },
    );
    await establishDeviceSession(
      BOB,
      BOB_DEVICE,
      ALICE,
      ALICE_DEVICE,
      sharedSecret,
      sessionId,
      {
        isInitiator: false,
        selfInitialDhPrivJwk: bobPrivateJwk,
        selfInitialDhPubB64: bobPublic,
      },
    );

    const encrypted = await ratchetEncrypt(ALICE, ALICE_DEVICE, BOB, BOB_DEVICE, 'bonjour');
    expect(encrypted).toMatch(/^aegis1\.ratchet\.s6/);

    const parts = encrypted!.split('.');
    parts[4] = String(Number(parts[4]) + 1);
    await expect(
      ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, parts.join('.')),
    ).resolves.toBeNull();

    await expect(
      ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, encrypted!),
    ).resolves.toBe('bonjour');
  });
});
