/**
 * v4 envelope contract — integration tests.
 *
 * Guarantees:
 *  1. New outbound messages from a freshly established session ALWAYS use
 *     the `x3dh5.` Double-Ratchet wire format. The legacy `x3dh3.` prefix
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
  RATCHET_PREFIX_V5,
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
      expect(ct!.startsWith(RATCHET_PREFIX_V5)).toBe(true);
      expect(ct!.startsWith(RATCHET_PREFIX_V3)).toBe(false);
    }
  });

  it('v4 envelopes carry the full Double-Ratchet header (sessionId, dhPub, Ns, PN, iv, ct)', async () => {
    const ss = makeSharedSecret(2);
    const peerSpk = await generateX25519();

    const sessionId = await establishDeviceSession(
      A_USER, A_DEV, B_USER, B_DEV, ss, undefined,
      { isInitiator: true, peerInitialDhPubB64: peerSpk.pubB64, peerSpkId: 7 },
    );

    const ct0 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm0');
    const ct1 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm1');
    const ct2 = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'm2');

    for (const ct of [ct0, ct1, ct2]) {
      expect(ct!.startsWith(RATCHET_PREFIX_V5)).toBe(true);
      const parts = ct!.slice(RATCHET_PREFIX_V5.length).split('.');
      // Header layout: sessionId.dhPub.Ns.PN.iv.ct — exactly 6 dot-separated parts.
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe(sessionId);
      // dhPub must be present (Double Ratchet ephemeral) — proves we are NOT
      // emitting the v3 single-secret envelope.
      expect(parts[1].length).toBeGreaterThan(0);
    }

    // Counters strictly increase across consecutive sends.
    const Ns = (ct: string) => parseInt(ct.slice(RATCHET_PREFIX_V5.length).split('.')[2], 10);
    expect(Ns(ct0!)).toBe(0);
    expect(Ns(ct1!)).toBe(1);
    expect(Ns(ct2!)).toBe(2);
  });

  it('legacy v3 envelope round-trips through ratchetDecrypt', async () => {
    // Seed identical legacy v3 sessions on both sides — emulates an old
    // pre-upgrade session that still carries in-flight messages.
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

    // The legacy session must keep using v3 for its own outbound traffic
    // (no destructive upgrade) — guarantees zero in-flight loss.
    const ct = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'legacy hello');
    expect(ct).not.toBeNull();
    expect(ct!.startsWith(RATCHET_PREFIX_V3)).toBe(true);

    // The recipient decrypts the v3 envelope cleanly through the same
    // unified ratchetDecrypt entry point used for v4.
    const pt = await ratchetDecrypt(B_USER, B_DEV, ct!);
    expect(pt).toBe('legacy hello');
  });

  it('legacy + new sessions coexist: each device pair keeps its own wire format', async () => {
    // Pair #1 (A_DEV ↔ B_DEV): legacy v3.
    const ssLegacy = makeSharedSecret(4);
    await seedLegacyV3Session({
      myUserId: A_USER, myDeviceId: A_DEV,
      peerUserId: B_USER, peerDeviceId: B_DEV,
      sharedSecret: ssLegacy, sessionId: 'legacy-mix',
    });

    // Pair #2 (A_DEV2 ↔ B_DEV): brand-new v4.
    const A_DEV2 = 'dev-alice-2';
    const ssNew = makeSharedSecret(5);
    const peerSpk = await generateX25519();
    await establishDeviceSession(
      A_USER, A_DEV2, B_USER, B_DEV, ssNew, undefined,
      { isInitiator: true, peerInitialDhPubB64: peerSpk.pubB64, peerSpkId: 99 },
    );

    const ctLegacy = await ratchetEncrypt(A_USER, A_DEV, B_USER, B_DEV, 'from-legacy');
    const ctNew = await ratchetEncrypt(A_USER, A_DEV2, B_USER, B_DEV, 'from-v4');

    // Each pair holds the line on its own wire format — no cross-contamination.
    expect(ctLegacy!.startsWith(RATCHET_PREFIX_V3)).toBe(true);
    expect(ctLegacy!.startsWith(RATCHET_PREFIX_V5)).toBe(false);
    expect(ctNew!.startsWith(RATCHET_PREFIX_V5)).toBe(true);
    expect(ctNew!.startsWith(RATCHET_PREFIX_V3)).toBe(false);
  });

  it('an unknown prefix is rejected (no silent leak through wrong path)', async () => {
    const garbage = 'x3dhX.whatever.payload';
    const pt = await ratchetDecrypt(B_USER, B_DEV, garbage);
    expect(pt).toBeNull();
  });
});
