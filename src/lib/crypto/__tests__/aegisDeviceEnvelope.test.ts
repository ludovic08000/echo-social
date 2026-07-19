import { beforeEach, describe, expect, it } from 'vitest';
import {
  AEGIS_RATCHET_PREFIX,
  clearAllDeviceSessions,
  establishDeviceSession,
  ratchetDecrypt,
  ratchetEncrypt,
} from '@/lib/crypto/deviceRatchet';

const A_USER = 'user-alice';
const A_DEV = 'dev-alice-1';
const B_USER = 'user-bob';
const B_DEV = 'dev-bob-1';

function makeSharedSecret(seed: number): ArrayBuffer {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed * 37 + index * 11) & 0xff;
  }
  return bytes.buffer;
}

async function generateX25519Public(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

describe('Aegis device envelope', () => {
  beforeEach(async () => {
    await clearAllDeviceSessions();
  });

  it('emits only the Aegis ratchet prefix', async () => {
    await establishDeviceSession(
      A_USER,
      A_DEV,
      B_USER,
      B_DEV,
      makeSharedSecret(1),
      undefined,
      {
        isInitiator: true,
        peerInitialDhPubB64: await generateX25519Public(),
        peerSpkId: 1,
      },
    );

    const encrypted = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'capsule');
    expect(encrypted).not.toBeNull();
    expect(encrypted!.startsWith(AEGIS_RATCHET_PREFIX)).toBe(true);
  });

  it('binds the complete Double Ratchet header', async () => {
    const sessionId = await establishDeviceSession(
      A_USER,
      A_DEV,
      B_USER,
      B_DEV,
      makeSharedSecret(2),
      undefined,
      {
        isInitiator: true,
        peerInitialDhPubB64: await generateX25519Public(),
        peerSpkId: 7,
      },
    );

    const first = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'first');
    const second = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'second');
    const firstParts = first!.slice(AEGIS_RATCHET_PREFIX.length).split('.');
    const secondParts = second!.slice(AEGIS_RATCHET_PREFIX.length).split('.');

    expect(firstParts).toHaveLength(6);
    expect(firstParts[0]).toBe(sessionId);
    expect(firstParts[2]).toBe('0');
    expect(secondParts[2]).toBe('1');
  });

  it('rejects every unknown device-copy prefix', async () => {
    await expect(ratchetDecrypt(B_USER, B_DEV, 'unknown.protocol.payload'))
      .resolves.toBeNull();
  });
});
