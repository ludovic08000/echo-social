/**
 * v5 envelope contract integration tests.
 *
 * Guarantees:
 *  1. New outbound messages from a freshly established session always use the
 *     `x3dh5.` Double-Ratchet wire format.
 *  2. Retired v3 sessions cannot emit new v3 traffic.
 *  3. Retired v3 state cannot contaminate a valid v5 device pair.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  establishDeviceSession,
  ratchetEncrypt,
  ratchetDecrypt,
  clearAllDeviceSessions,
  RATCHET_PREFIX_V5,
} from '@/lib/crypto/deviceRatchet';

const A_USER = 'user-alice';
const A_DEV = 'dev-alice-1';
const B_USER = 'user-bob';
const B_DEV = 'dev-bob-1';

const DB_NAME = 'forsure-device-sessions';
const DB_VERSION = 4;
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

async function seedRetiredV3Session(opts: {
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
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
      legacySharedSecretB64: bufToB64(opts.sharedSecret.slice(0, 32)),
      dhsPrivJwk: null,
      dhsPubB64: null,
      dhrPubB64: null,
      ckSendB64: null,
      ckRecvB64: null,
      Ns: 0,
      Nr: 0,
      PN: 0,
      skipped: [],
      createdAt: Date.now(),
      peerSpkId: null,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('v5 envelope contract outbound + retired legacy guard', () => {
  beforeEach(async () => {
    await clearAllDeviceSessions();
  });

  it('a freshly established session always produces x3dh5 envelopes', async () => {
    const ss = makeSharedSecret(1);
    const peerSpk = await generateX25519();

    await establishDeviceSession(
      A_USER,
      A_DEV,
      B_USER,
      B_DEV,
      ss,
      undefined,
      { isInitiator: true, peerInitialDhPubB64: peerSpk.pubB64, peerSpkId: 1 },
    );

    for (let i = 0; i < 5; i++) {
      const ct = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, `msg-${i}`);
      expect(ct).not.toBeNull();
      expect(ct!.startsWith(RATCHET_PREFIX_V5)).toBe(true);
      expect(ct!.startsWith('x3dh3.')).toBe(false);
    }
  });

  it('x3dh5 envelopes carry the full Double-Ratchet header', async () => {
    const ss = makeSharedSecret(2);
    const peerSpk = await generateX25519();

    const sessionId = await establishDeviceSession(
      A_USER,
      A_DEV,
      B_USER,
      B_DEV,
      ss,
      undefined,
      { isInitiator: true, peerInitialDhPubB64: peerSpk.pubB64, peerSpkId: 7 },
    );

    const ct0 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm0');
    const ct1 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm1');
    const ct2 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm2');

    for (const ct of [ct0, ct1, ct2]) {
      expect(ct!.startsWith(RATCHET_PREFIX_V5)).toBe(true);
      const parts = ct!.slice(RATCHET_PREFIX_V5.length).split('.');
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe(sessionId);
      expect(parts[1].length).toBeGreaterThan(0);
    }

    const ns = (ct: string) => parseInt(ct.slice(RATCHET_PREFIX_V5.length).split('.')[2], 10);
    expect(ns(ct0!)).toBe(0);
    expect(ns(ct1!)).toBe(1);
    expect(ns(ct2!)).toBe(2);
  });

  it('retired v3 sessions cannot emit or decrypt new ciphertext', async () => {
    const ss = makeSharedSecret(3);

    await seedRetiredV3Session({
      myUserId: A_USER,
      myDeviceId: A_DEV,
      peerUserId: B_USER,
      peerDeviceId: B_DEV,
      sharedSecret: ss,
      sessionId: 'legacy-sess-1',
    });
    await seedRetiredV3Session({
      myUserId: B_USER,
      myDeviceId: B_DEV,
      peerUserId: A_USER,
      peerDeviceId: A_DEV,
      sharedSecret: ss,
      sessionId: 'legacy-sess-1',
    });

    const ct = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'legacy hello');
    expect(ct).toBeNull();

    const pt = await ratchetDecrypt(B_USER, B_DEV, 'x3dh3.legacy-sess-1.0.iv.ct');
    expect(pt).toBeNull();
  });

  it('retired v3 state does not contaminate a valid v5 device pair', async () => {
    await seedRetiredV3Session({
      myUserId: A_USER,
      myDeviceId: A_DEV,
      peerUserId: B_USER,
      peerDeviceId: B_DEV,
      sharedSecret: makeSharedSecret(4),
      sessionId: 'legacy-mix',
    });

    const aDev2 = 'dev-alice-2';
    const peerSpk = await generateX25519();
    await establishDeviceSession(
      A_USER,
      aDev2,
      B_USER,
      B_DEV,
      makeSharedSecret(5),
      undefined,
      { isInitiator: true, peerInitialDhPubB64: peerSpk.pubB64, peerSpkId: 99 },
    );

    const ctLegacy = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'from-legacy');
    const ctNew = await ratchetEncrypt(A_USER, aDev2, B_USER, B_DEV, 'from-v5');

    expect(ctLegacy).toBeNull();
    expect(ctNew).not.toBeNull();
    expect(ctNew!.startsWith(RATCHET_PREFIX_V5)).toBe(true);
    expect(ctNew!.startsWith('x3dh3.')).toBe(false);
  });

  it('an unknown prefix is rejected', async () => {
    const pt = await ratchetDecrypt(B_USER, B_DEV, 'x3dhX.whatever.payload');
    expect(pt).toBeNull();
  });
});
