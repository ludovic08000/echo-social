/**
 * Device-pair Double Ratchet tests.
 *
 * These tests exercise the real bootstrap contract used by X3DH: the initiator
 * creates one session id and the responder installs the same id from the
 * initial pre-key envelope. No test injects an already-advanced receive chain.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AEGIS_RATCHET_PREFIX,
  clearAllDeviceSessions,
  establishDeviceSession,
  invalidateDeviceSession,
  listKnownSessionIds,
  ratchetDecrypt,
  ratchetEncrypt,
} from '@/lib/crypto/deviceRatchet';
import { VALID_AEGIS_SESSION_ID } from '@/test/aegisWireFixtures';

const A_USER = 'user-alice';
const A_DEV = 'dev-alice-1';
const B_USER = 'user-bob';
const B_DEV = 'dev-bob-1';

function makeSharedSecret(seed: number): ArrayBuffer {
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) buf[i] = (seed * 31 + i) & 0xff;
  return buf.buffer;
}

async function generateX25519(): Promise<{ pubB64: string; privJwk: JsonWebKey }> {
  const kp = (await crypto.subtle.generateKey(
    { name: 'X25519' } as Algorithm,
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return {
    pubB64: btoa(String.fromCharCode(...new Uint8Array(raw))),
    privJwk: jwk,
  };
}

async function establishPair(seed: number, peerSpkId = 1): Promise<string> {
  const sharedSecret = makeSharedSecret(seed);
  const responderPreKey = await generateX25519();
  const sessionId = await establishDeviceSession(
    A_USER,
    A_DEV,
    B_USER,
    B_DEV,
    sharedSecret,
    undefined,
    {
      isInitiator: true,
      peerInitialDhPubB64: responderPreKey.pubB64,
      peerSpkId,
      selfIkPubB64: `ik-${A_DEV}`,
      peerIkPubB64: `ik-${B_DEV}`,
    },
  );

  await establishDeviceSession(
    B_USER,
    B_DEV,
    A_USER,
    A_DEV,
    sharedSecret,
    sessionId,
    {
      isInitiator: false,
      peerSpkId,
      selfInitialDhPrivJwk: responderPreKey.privJwk,
      selfInitialDhPubB64: responderPreKey.pubB64,
      selfIkPubB64: `ik-${B_DEV}`,
      peerIkPubB64: `ik-${A_DEV}`,
    },
  );
  return sessionId;
}

describe('deviceRatchet — real bootstrap and Double Ratchet', () => {
  beforeEach(async () => {
    await clearAllDeviceSessions();
  });

  it('initiator can encrypt the first message immediately after bootstrap', async () => {
    const sessionId = await establishPair(1, 42);
    const ciphertext = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'hello bob');

    expect(ciphertext).not.toBeNull();
    expect(ciphertext!.startsWith(AEGIS_RATCHET_PREFIX)).toBe(true);
    const parts = ciphertext!.slice(AEGIS_RATCHET_PREFIX.length).split('.');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe(sessionId);
    expect(parts[2]).toBe('0');
  });

  it('responder decrypts the first message from the transmitted session id', async () => {
    await establishPair(2, 7);
    const ciphertext = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'first inbound');

    expect(ciphertext).not.toBeNull();
    await expect(ratchetDecrypt(B_USER, B_DEV, ciphertext!)).resolves.toBe('first inbound');
  });

  it('supports a bidirectional conversation after the first inbound message', async () => {
    await establishPair(3);

    for (let index = 0; index < 3; index += 1) {
      const ciphertext = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, `msg-A-${index}`);
      await expect(ratchetDecrypt(B_USER, B_DEV, ciphertext!)).resolves.toBe(`msg-A-${index}`);
    }

    const reply = await ratchetEncrypt(B_USER, B_DEV, A_USER, A_DEV, 'reply from bob');
    expect(reply).not.toBeNull();
    await expect(ratchetDecrypt(A_USER, A_DEV, reply!)).resolves.toBe('reply from bob');
  });

  it('decrypts out-of-order messages through the bounded skipped-key cache', async () => {
    await establishPair(4, 9);

    const ciphertext0 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm0');
    const ciphertext1 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm1');
    const ciphertext2 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm2');

    await expect(ratchetDecrypt(B_USER, B_DEV, ciphertext2!)).resolves.toBe('m2');
    await expect(ratchetDecrypt(B_USER, B_DEV, ciphertext0!)).resolves.toBe('m0');
    await expect(ratchetDecrypt(B_USER, B_DEV, ciphertext1!)).resolves.toBe('m1');
  });

  it('rejects replay of an already consumed message key', async () => {
    await establishPair(5);
    const ciphertext = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'once');

    await expect(ratchetDecrypt(B_USER, B_DEV, ciphertext!)).resolves.toBe('once');
    await expect(ratchetDecrypt(B_USER, B_DEV, ciphertext!)).resolves.toBeNull();
  });

  it('rejects ciphertext or authenticated-header tampering', async () => {
    await establishPair(6);
    const ciphertext = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'authenticate me');
    expect(ciphertext).not.toBeNull();

    const bodyTampered = `${ciphertext!.slice(0, -2)}${ciphertext!.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    await expect(ratchetDecrypt(B_USER, B_DEV, bodyTampered)).resolves.toBeNull();

    const parts = ciphertext!.slice(AEGIS_RATCHET_PREFIX.length).split('.');
    parts[2] = String(Number(parts[2]) + 1);
    const headerTampered = `${AEGIS_RATCHET_PREFIX}${parts.join('.')}`;
    await expect(ratchetDecrypt(B_USER, B_DEV, headerTampered)).resolves.toBeNull();
  });

  it('returns null when no session exists', async () => {
    await expect(ratchetEncrypt('ghost', 'ghost-dev', B_USER, B_DEV, 'no session')).resolves.toBeNull();
  });

  it('lists only sessions for the requested local device', async () => {
    const sharedSecret = makeSharedSecret(7);
    const peerPreKey = await generateX25519();
    await establishDeviceSession(A_USER, A_DEV, B_USER, B_DEV, sharedSecret, VALID_AEGIS_SESSION_ID, {
      isInitiator: true,
      peerInitialDhPubB64: peerPreKey.pubB64,
      selfIkPubB64: `ik-${A_DEV}`,
      peerIkPubB64: `ik-${B_DEV}`,
    });
    await establishDeviceSession(A_USER, 'dev-alice-other', B_USER, B_DEV, sharedSecret, 's_BBBBBBBBBBBBBBBBBBBBBB', {
      isInitiator: true,
      peerInitialDhPubB64: peerPreKey.pubB64,
      selfIkPubB64: 'ik-dev-alice-other',
      peerIkPubB64: `ik-${B_DEV}`,
    });

    const known = await listKnownSessionIds(A_USER, A_DEV);
    const ids = known.map((session) => session.sessionId);
    expect(ids).toContain(VALID_AEGIS_SESSION_ID);
    expect(ids).not.toContain('s_BBBBBBBBBBBBBBBBBBBBBB');
  });

  it('invalidating a device session forces a new X3DH bootstrap', async () => {
    await establishPair(8);
    await expect(ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'before')).resolves.not.toBeNull();

    await invalidateDeviceSession(A_USER, A_DEV, B_USER, B_DEV);
    await expect(ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'after')).resolves.toBeNull();
  });
});
