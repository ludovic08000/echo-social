/**
 * End-to-end integration tests for the multi-device E2EE pipeline.
 *
 * Scenario: Alice owns 2 devices (A1, A2), Bob owns 2 devices (B1, B2).
 * Each pair (sender device → receiver device) holds an *independent* Double
 * Ratchet session, established by an X3DH-style handshake (here we shortcut
 * the network bundle exchange and inject a shared secret directly into
 * `establishDeviceSession`, which is exactly what `x3dhWrapForDevice` does
 * once it has computed the 4-DH secret).
 *
 * What this proves:
 *   1. Two devices of the same user maintain independent ratchet states.
 *   2. Bidirectional traffic round-trips through the Double Ratchet (PCS).
 *   3. Out-of-order delivery still decrypts (skipped-key cache).
 *   4. Invalidating a session forces a clean re-handshake without state bleed.
 *   5. Sessions for revoked devices can be wiped without affecting peers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  establishDeviceSession,
  ratchetEncrypt,
  ratchetDecrypt,
  invalidateDeviceSession,
  clearAllDeviceSessions,
  getSessionPeerSpkId,
} from '../deviceRatchet';
import { hardCrypto } from '../cryptoIntegrity';
import { bufferToBase64 } from '../utils';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Generate a fresh X25519 key pair and return { privJwk, pubB64 }. */
async function genX25519() {
  const kp = (await hardCrypto.generateKey({ name: 'X25519' } as any, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pubRaw = await hardCrypto.exportKey('raw', kp.publicKey);
  return {
    priv: kp.privateKey,
    privJwk: await hardCrypto.exportKey('jwk', kp.privateKey),
    pubB64: bufferToBase64(pubRaw as ArrayBuffer),
  };
}

/** Random 32-byte shared secret — stand-in for the X3DH 4-DH output. */
function randomSecret(): ArrayBuffer {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b.buffer;
}

/**
 * Set up a one-way ratchet link from `from` to `to`. Both sides install the
 * same shared secret; the initiator (`from`) immediately runs a DH-ratchet
 * step using `peerInitial.pubB64` as the receiver's "initial" pub. The
 * receiver stores the secret only — it derives its sending chain on its
 * first reply via the in-band DH-ratchet step.
 */
async function handshake(
  from: { user: string; device: string },
  to: { user: string; device: string },
  peerSpkId = 1,
): Promise<{ sessionId: string; peerInitialPubB64: string }> {
  const peerInitial = await genX25519();
  const secret = randomSecret();
  const sessionId = await establishDeviceSession(
    from.user,
    from.device,
    to.user,
    to.device,
    secret,
    undefined,
    { peerInitialDhPubB64: peerInitial.pubB64, isInitiator: true, peerSpkId },
  );
  // Receiver mirrors the same secret + sessionId, but is NOT initiator.
  await establishDeviceSession(
    to.user,
    to.device,
    from.user,
    from.device,
    secret,
    sessionId,
    { peerInitialDhPubB64: null, isInitiator: false, peerSpkId },
  );
  return { sessionId, peerInitialPubB64: peerInitial.pubB64 };
}

const A = { user: 'alice', device: 'A1' };
const A2 = { user: 'alice', device: 'A2' };
const B = { user: 'bob', device: 'B1' };
const B2 = { user: 'bob', device: 'B2' };

beforeEach(async () => {
  await clearAllDeviceSessions();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('multi-device E2EE — single pair round-trip', () => {
  it('encrypts on A1 and decrypts on B1', async () => {
    await handshake(A, B);

    const env = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'hello bob');
    expect(env).not.toBeNull();
    expect(env!.startsWith('x3dh4.')).toBe(true);

    const pt = await ratchetDecrypt(B.user, B.device, env!);
    expect(pt).toBe('hello bob');
  });

  it('supports bidirectional reply (DH-ratchet step on receiver)', async () => {
    await handshake(A, B);

    // A → B
    const env1 = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'ping');
    expect(await ratchetDecrypt(B.user, B.device, env1!)).toBe('ping');

    // B → A : on first reply, B runs its own DH-ratchet step.
    const env2 = await ratchetEncrypt(B.user, B.device, A.user, A.device, 'pong');
    expect(env2).not.toBeNull();
    expect(await ratchetDecrypt(A.user, A.device, env2!)).toBe('pong');

    // A → B again, after the round trip
    const env3 = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'ping2');
    expect(await ratchetDecrypt(B.user, B.device, env3!)).toBe('ping2');
  });
});

describe('multi-device E2EE — independent device sessions', () => {
  it('A1↔B1 and A1↔B2 use independent ratchet states', async () => {
    await handshake(A, B);
    await handshake(A, B2);

    const toB1 = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'msg-to-B1');
    const toB2 = await ratchetEncrypt(A.user, A.device, B2.user, B2.device, 'msg-to-B2');
    expect(toB1).not.toBe(toB2);

    expect(await ratchetDecrypt(B.user, B.device, toB1!)).toBe('msg-to-B1');
    expect(await ratchetDecrypt(B2.user, B2.device, toB2!)).toBe('msg-to-B2');

    // Wrong device cannot decrypt a message addressed to its sibling.
    expect(await ratchetDecrypt(B.user, B.device, toB2!)).toBeNull();
    expect(await ratchetDecrypt(B2.user, B2.device, toB1!)).toBeNull();
  });

  it('A1 and A2 each maintain their own session with B1', async () => {
    await handshake(A, B);
    await handshake(A2, B);

    const fromA1 = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'from-A1');
    const fromA2 = await ratchetEncrypt(A2.user, A2.device, B.user, B.device, 'from-A2');

    expect(await ratchetDecrypt(B.user, B.device, fromA1!)).toBe('from-A1');
    expect(await ratchetDecrypt(B.user, B.device, fromA2!)).toBe('from-A2');
  });
});

describe('multi-device E2EE — out-of-order delivery', () => {
  it('decrypts messages received in reverse order using skipped-key cache', async () => {
    await handshake(A, B);

    const e1 = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'm1');
    const e2 = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'm2');
    const e3 = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'm3');

    // Deliver out-of-order: m3 first, then m1, then m2.
    expect(await ratchetDecrypt(B.user, B.device, e3!)).toBe('m3');
    expect(await ratchetDecrypt(B.user, B.device, e1!)).toBe('m1');
    expect(await ratchetDecrypt(B.user, B.device, e2!)).toBe('m2');
  });

  it('does not re-decrypt the same envelope twice (key consumed)', async () => {
    await handshake(A, B);
    const env = await ratchetEncrypt(A.user, A.device, B.user, B.device, 'once');
    expect(await ratchetDecrypt(B.user, B.device, env!)).toBe('once');
    // Key was consumed on first decrypt → second attempt must fail.
    expect(await ratchetDecrypt(B.user, B.device, env!)).toBeNull();
  });
});

describe('multi-device E2EE — session invalidation & revocation', () => {
  it('invalidating a session breaks future encryption (forces re-X3DH)', async () => {
    await handshake(A, B);
    expect(
      await ratchetEncrypt(A.user, A.device, B.user, B.device, 'before'),
    ).not.toBeNull();

    await invalidateDeviceSession(A.user, A.device, B.user, B.device);
    expect(
      await ratchetEncrypt(A.user, A.device, B.user, B.device, 'after'),
    ).toBeNull();
  });

  it('invalidating one peer device does not affect another peer device', async () => {
    await handshake(A, B);
    await handshake(A, B2);

    await invalidateDeviceSession(A.user, A.device, B.user, B.device);

    // Link to B1 is gone …
    expect(
      await ratchetEncrypt(A.user, A.device, B.user, B.device, 'x'),
    ).toBeNull();
    // … but link to B2 still works.
    const env = await ratchetEncrypt(A.user, A.device, B2.user, B2.device, 'still-here');
    expect(env).not.toBeNull();
    expect(await ratchetDecrypt(B2.user, B2.device, env!)).toBe('still-here');
  });

  it('records and exposes the peer SPK id used at handshake time', async () => {
    await handshake(A, B, 42);
    const spkId = await getSessionPeerSpkId(A.user, A.device, B.user, B.device);
    expect(spkId).toBe(42);
  });
});

describe('multi-device E2EE — fan-out simulation', () => {
  it('A1 broadcasts a single logical message to every receiver device', async () => {
    // Alice has 2 devices, Bob has 2 devices. From A1, the fan-out targets
    // A2 (own other device) + B1 + B2.
    await handshake(A, A2);
    await handshake(A, B);
    await handshake(A, B2);

    const targets = [A2, B, B2];
    const message = 'hi from A1';
    const envelopes = await Promise.all(
      targets.map(t => ratchetEncrypt(A.user, A.device, t.user, t.device, message)),
    );

    // Each fan-out envelope is distinct (different ratchet state per peer).
    const unique = new Set(envelopes);
    expect(unique.size).toBe(envelopes.length);

    // Every receiver decrypts to the same plaintext.
    const plaintexts = await Promise.all(
      targets.map((t, i) => ratchetDecrypt(t.user, t.device, envelopes[i]!)),
    );
    expect(plaintexts).toEqual([message, message, message]);
  });
});
