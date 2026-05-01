/**
 * v4 envelope contract — integration tests.
 *
 * Guarantees:
 *  1. New outbound messages from a freshly established session ALWAYS use
 *     the `x3dh4.` Double-Ratchet wire format. The legacy `x3dh3.` prefix
 *     must never leak into outbound traffic for new sessions.
 *  2. The decryption path correctly handles BOTH:
 *     - v4 envelopes (current Double Ratchet wire format).
 *     - v3 legacy envelopes (single-secret HKDF) for in-flight messages
 *       from sessions established before the v4 upgrade.
 *  3. A peer that holds a legacy v3 session keeps using v3 for its own
 *     outbound traffic (no destructive upgrade) — guarantees zero message
 *     loss during the transition window.
 *  4. Mixed sessions decrypt correctly on the recipient side regardless of
 *     which prefix arrives.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  establishDeviceSession,
  ratchetEncrypt,
  ratchetDecrypt,
  clearAllDeviceSessions,
  RATCHET_PREFIX_V3,
  RATCHET_PREFIX_V4,
} from '@/lib/crypto/deviceRatchet';

const A_USER = 'user-alice';
const A_DEV = 'dev-alice-1';
const B_USER = 'user-bob';
const B_DEV = 'dev-bob-1';

const DB_NAME = 'forsure-device-sessions';
const DB_VERSION = 2;
const STORE = 'sessions';

function makeSharedSecret(seed: number): ArrayBuffer {
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed * 37 + i * 11) & 0xff;
  return buf.buffer;
}

async function generateX25519(): Promise<{ pubB64: string; privJwk: JsonWebKey }> {
  const kp = (await crypto.subtle.generateKey(
    { name: 'X25519' } as any, true, ['deriveBits'],
  )) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return {
    pubB64: btoa(String.fromCharCode(...new Uint8Array(raw))),
    privJwk: jwk,
  };
}

function bufToB64(b: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(b)));
}

/**
 * Open the same IndexedDB used by `deviceRatchet` and seed a synthetic
 * legacy v3 session — emulates a session that was established before the
 * v4 upgrade and persisted on disk.
 */
async function seedLegacyV3Session(opts: {
  myUserId: string; myDeviceId: string;
  peerUserId: string; peerDeviceId: string;
  sharedSecret: ArrayBuffer;
  sessionId: string;
}): Promise<void> {
  const id = `${opts.myUserId}::${opts.myDeviceId}::${opts.peerUserId}::${opts.peerDeviceId}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      id,
      sessionId: opts.sessionId,
      rootKeyB64: bufToB64(opts.sharedSecret.slice(0, 32)),
      // Legacy markers: no DH ratchet material, only a shared secret.
      legacySharedSecretB64: bufToB64(opts.sharedSecret.slice(0, 32)),
      dhsPrivJwk: null,
      dhsPubB64: null,
      dhrPubB64: null,
      ckSendB64: null,
      ckRecvB64: null,
      Ns: 0, Nr: 0, PN: 0,
      skipped: [],
      createdAt: Date.now(),
      peerSpkId: null,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('v4 envelope contract — outbound + legacy read', () => {
  beforeEach(async () => {
    await clearAllDeviceSessions();
  });

  it('a freshly established session ALWAYS produces x3dh4 envelopes', async () => {
    const ss = makeSharedSecret(1);
    const peerSpk = await generateX25519();

    await establishDeviceSession(
      A_USER, A_DEV, B_USER, B_DEV, ss, undefined,
      { isInitiator: true, peerInitialDhPubB64: peerSpk.pubB64, peerSpkId: 1 },
    );

    for (let i = 0; i < 5; i++) {
      const ct = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, `msg-${i}`);
      expect(ct).not.toBeNull();
      expect(ct!.startsWith(RATCHET_PREFIX_V4)).toBe(true);
      expect(ct!.startsWith(RATCHET_PREFIX_V3)).toBe(false);
    }
  });

  it('the receiver decrypts v4 envelopes end-to-end', async () => {
    const ss = makeSharedSecret(2);
    const peerSpk = await generateX25519();

    await establishDeviceSession(
      A_USER, A_DEV, B_USER, B_DEV, ss, undefined,
      {
        isInitiator: true,
        peerInitialDhPubB64: peerSpk.pubB64,
        peerSpkId: 7,
      },
    );

    // Bob is primed with his SPK keypair (Sesame priming) so he can decrypt
    // Alice's first v4 message and reply.
    await establishDeviceSession(
      B_USER, B_DEV, A_USER, A_DEV, ss, undefined,
      {
        isInitiator: false,
        selfInitialDhPrivJwk: peerSpk.privJwk,
        selfInitialDhPubB64: peerSpk.pubB64,
        peerSpkId: 7,
      },
    );

    const ct = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'hello v4');
    expect(ct!.startsWith(RATCHET_PREFIX_V4)).toBe(true);

    const pt = await ratchetDecrypt(B_USER, B_DEV, ct!);
    expect(pt).toBe('hello v4');
  });

  it('decryption path accepts a legacy x3dh3 envelope from an old session', async () => {
    // Seed identical legacy v3 sessions on both sides.
    const ss = makeSharedSecret(3);
    const sessionId = 'legacy-sess-1';

    await seedLegacyV3Session({
      myUserId: A_USER, myDeviceId: A_DEV,
      peerUserId: B_USER, peerDeviceId: B_DEV,
      sharedSecret: ss, sessionId,
    });
    await seedLegacyV3Session({
      myUserId: B_USER, myDeviceId: B_DEV,
      peerUserId: A_USER, peerDeviceId: A_DEV,
      sharedSecret: ss, sessionId,
    });

    // Alice's outbound through the legacy session must keep the v3 prefix
    // (no destructive upgrade — guarantees in-flight messages stay readable).
    const ct = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'legacy hello');
    expect(ct).not.toBeNull();
    expect(ct!.startsWith(RATCHET_PREFIX_V3)).toBe(true);

    // Bob decrypts the v3 envelope cleanly.
    const pt = await ratchetDecrypt(B_USER, B_DEV, ct!);
    expect(pt).toBe('legacy hello');
  });

  it('a single recipient handles BOTH v3 (legacy) and v4 (new) envelopes', async () => {
    // Bob has a legacy v3 session with Alice (old device pair).
    const ssLegacy = makeSharedSecret(4);
    await seedLegacyV3Session({
      myUserId: A_USER, myDeviceId: A_DEV,
      peerUserId: B_USER, peerDeviceId: B_DEV,
      sharedSecret: ssLegacy, sessionId: 'legacy-mix',
    });
    await seedLegacyV3Session({
      myUserId: B_USER, myDeviceId: B_DEV,
      peerUserId: A_USER, peerDeviceId: A_DEV,
      sharedSecret: ssLegacy, sessionId: 'legacy-mix',
    });

    // Bob also has a brand-new v4 session with Alice's second device.
    const A_DEV2 = 'dev-alice-2';
    const ssNew = makeSharedSecret(5);
    const peerSpk = await generateX25519();
    await establishDeviceSession(
      A_USER, A_DEV2, B_USER, B_DEV, ssNew, undefined,
      { isInitiator: true, peerInitialDhPubB64: peerSpk.pubB64, peerSpkId: 99 },
    );
    await establishDeviceSession(
      B_USER, B_DEV, A_USER, A_DEV2, ssNew, undefined,
      {
        isInitiator: false,
        selfInitialDhPrivJwk: peerSpk.privJwk,
        selfInitialDhPubB64: peerSpk.pubB64,
        peerSpkId: 99,
      },
    );

    // Alice ships one envelope from each device.
    const ctLegacy = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'from-legacy');
    const ctNew = await ratchetEncrypt(A_USER, A_DEV2, B_USER, B_DEV, 'from-v4');

    expect(ctLegacy!.startsWith(RATCHET_PREFIX_V3)).toBe(true);
    expect(ctNew!.startsWith(RATCHET_PREFIX_V4)).toBe(true);

    // Bob decrypts both, in arbitrary order.
    const ptNew = await ratchetDecrypt(B_USER, B_DEV, ctNew!);
    const ptLegacy = await ratchetDecrypt(B_USER, B_DEV, ctLegacy!);

    expect(ptNew).toBe('from-v4');
    expect(ptLegacy).toBe('from-legacy');
  });

  it('an unknown prefix is rejected (no silent leak through wrong path)', async () => {
    const garbage = 'x3dhX.whatever.payload';
    const pt = await ratchetDecrypt(B_USER, B_DEV, garbage);
    expect(pt).toBeNull();
  });
});
