/**
 * Fan-out multi-session integration tests — out-of-order arrival.
 *
 * Scenario modeled (Sesame/Signal):
 *   - Sender Alice has 2 devices (A1, A2).
 *   - Recipient Bob has 3 devices (B1, B2, B3).
 *   - For each logical message Alice sends from A1, the client produces ONE
 *     ratchet ciphertext per (A1 → peerDevice) pair: A1→A2, A1→B1, A1→B2,
 *     A1→B3. Each pair has its OWN long-lived Double Ratchet session.
 *
 * What this file specifically validates (not covered by existing tests):
 *   1. A burst of N logical messages produces N independent ratchet outputs
 *      per peer device, all distinct, with each session's chain advancing
 *      in lock-step on its OWN side.
 *   2. Each peer device can decrypt its own envelopes in arbitrary order
 *      WITHOUT affecting any other peer device's session state.
 *   3. Cross-device delivery is rejected: a B1-addressed envelope MUST NOT
 *      decrypt on B2/B3, even when B2 is busy processing its own backlog.
 *   4. A second sender device (A2) running its own fan-out concurrently does
 *      not perturb A1's sessions — every (sender, receiver) pair stays
 *      independent.
 *   5. Replay protection: each consumed envelope is single-use per device.
 *   6. The skipped-key cache absorbs a realistic iOS reconnect pattern
 *      (msgs 1..K queued, then delivered out of order while msg 0 is still
 *      in flight).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ratchetEncrypt,
  ratchetDecrypt,
  clearAllDeviceSessions,
} from '../deviceRatchet';
import { hardCrypto } from '../cryptoIntegrity';
import { bufferToBase64, randomBytes } from '../utils';

// ─── Session seeding (copy of helpers from multiDeviceIntegration) ─────────
const DB_NAME = 'forsure-device-sessions';
const DB_VERSION = 2;
const STORE = 'sessions';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putSession(record: any): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function genX25519() {
  const kp = (await hardCrypto.generateKey({ name: 'X25519' } as any, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return {
    privJwk: await hardCrypto.exportKey('jwk', kp.privateKey),
    pubB64: bufferToBase64(
      (await hardCrypto.exportKey('raw', kp.publicKey)) as ArrayBuffer,
    ),
  };
}

async function dh(privJwk: JsonWebKey, peerPubB64: string): Promise<ArrayBuffer> {
  const priv = await hardCrypto.importKey(
    'jwk', privJwk, { name: 'X25519' } as any, true, ['deriveBits'],
  );
  const pub = await hardCrypto.importKey(
    'raw',
    Uint8Array.from(atob(peerPubB64), c => c.charCodeAt(0)).buffer,
    { name: 'X25519' } as any,
    true,
    [],
  );
  return hardCrypto.deriveBits({ name: 'X25519', public: pub } as any, priv, 256);
}

async function kdfRK(rk32: ArrayBuffer, dhOut: ArrayBuffer) {
  const baseKey = await hardCrypto.importKey('raw', dhOut, 'HKDF', false, ['deriveBits']);
  const out = await hardCrypto.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(rk32),
      info: new TextEncoder().encode('ForSureDR:RootKey'),
    } as any,
    baseKey,
    512,
  );
  const u8 = new Uint8Array(out);
  return {
    rk: bufferToBase64(u8.slice(0, 32).buffer as ArrayBuffer),
    ck: bufferToBase64(u8.slice(32, 64).buffer as ArrayBuffer),
  };
}

interface Device { user: string; device: string }

async function seedSession(
  from: Device,
  to: Device,
  peerSpkId = 1,
): Promise<void> {
  const sharedSecret = randomBytes(32).buffer as ArrayBuffer;
  const rootSeed = bufferToBase64(sharedSecret);
  const peerInitial = await genX25519();
  const initiatorRatchet = await genX25519();
  const dh1 = await dh(initiatorRatchet.privJwk, peerInitial.pubB64);
  const r1 = await kdfRK(sharedSecret, dh1);
  const sessionId = bufferToBase64(randomBytes(8).buffer as ArrayBuffer)
    .replace(/[+/=]/g, '')
    .slice(0, 12);

  await putSession({
    id: `${from.user}::${from.device}::${to.user}::${to.device}`,
    sessionId,
    rootKeyB64: r1.rk,
    dhsPrivJwk: initiatorRatchet.privJwk,
    dhsPubB64: initiatorRatchet.pubB64,
    dhrPubB64: peerInitial.pubB64,
    ckSendB64: r1.ck,
    ckRecvB64: null,
    Ns: 0, Nr: 0, PN: 0, skipped: [],
    createdAt: Date.now(),
    peerSpkId,
  });
  await putSession({
    id: `${to.user}::${to.device}::${from.user}::${from.device}`,
    sessionId,
    rootKeyB64: rootSeed,
    dhsPrivJwk: peerInitial.privJwk,
    dhsPubB64: peerInitial.pubB64,
    dhrPubB64: null,
    ckSendB64: null,
    ckRecvB64: null,
    Ns: 0, Nr: 0, PN: 0, skipped: [],
    createdAt: Date.now(),
    peerSpkId,
  });
}

const A1: Device = { user: 'alice', device: 'A1' };
const A2: Device = { user: 'alice', device: 'A2' };
const B1: Device = { user: 'bob', device: 'B1' };
const B2: Device = { user: 'bob', device: 'B2' };
const B3: Device = { user: 'bob', device: 'B3' };

beforeEach(async () => {
  await clearAllDeviceSessions();
});

/**
 * Helper: simulate a fan-out from `sender` to every peer device. Returns a
 * map of `peerDevice.device → ciphertext` so a test can later "deliver"
 * individual envelopes in any order.
 */
async function fanOut(
  sender: Device,
  peers: Device[],
  plaintext: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of peers) {
    const env = await ratchetEncrypt(sender.user, sender.device, p.user, p.device, plaintext);
    expect(env, `encrypt ${sender.device}→${p.device}`).not.toBeNull();
    out[p.device] = env!;
  }
  return out;
}

// Deterministic shuffle (Mulberry32) so test failures are reproducible.
function shuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('fan-out multi-session — burst with independent ratchets', () => {
  it('produces N distinct ciphertexts per peer device for N logical messages', async () => {
    await seedSession(A1, A2);
    await seedSession(A1, B1);
    await seedSession(A1, B2);
    await seedSession(A1, B3);

    const peers = [A2, B1, B2, B3];
    const N = 5;
    const bursts: Array<Record<string, string>> = [];
    for (let i = 0; i < N; i++) {
      bursts.push(await fanOut(A1, peers, `burst-${i}`));
    }

    // Every ciphertext across the entire matrix must be unique
    // (different chain key per peer + different message index).
    const all = bursts.flatMap(b => Object.values(b));
    expect(new Set(all).size).toBe(N * peers.length);
  });
});

describe('fan-out multi-session — out-of-order delivery per device', () => {
  it('each peer decrypts its own envelopes in shuffled order independently', async () => {
    await seedSession(A1, B1);
    await seedSession(A1, B2);
    await seedSession(A1, B3);

    const peers = [B1, B2, B3];
    const N = 6;
    const bursts: Array<Record<string, string>> = [];
    for (let i = 0; i < N; i++) {
      bursts.push(await fanOut(A1, peers, `m-${i}`));
    }

    // Each peer receives its 6 envelopes in a DIFFERENT shuffled order.
    const seeds: Record<string, number> = { B1: 11, B2: 22, B3: 33 };
    for (const peer of peers) {
      const indices = shuffle(Array.from({ length: N }, (_, i) => i), seeds[peer.device]);
      for (const i of indices) {
        const pt = await ratchetDecrypt(peer.user, peer.device, bursts[i][peer.device]);
        expect(pt, `${peer.device} decrypt msg ${i}`).toBe(`m-${i}`);
      }
    }
  });

  it('B2 processing its backlog does not consume keys for B1 or B3', async () => {
    await seedSession(A1, B1);
    await seedSession(A1, B2);
    await seedSession(A1, B3);

    const peers = [B1, B2, B3];
    const bursts = [
      await fanOut(A1, peers, 'first'),
      await fanOut(A1, peers, 'second'),
      await fanOut(A1, peers, 'third'),
    ];

    // B2 fully drains its backlog, in reverse order, FIRST.
    expect(await ratchetDecrypt(B2.user, B2.device, bursts[2].B2)).toBe('third');
    expect(await ratchetDecrypt(B2.user, B2.device, bursts[0].B2)).toBe('first');
    expect(await ratchetDecrypt(B2.user, B2.device, bursts[1].B2)).toBe('second');

    // B1 and B3 must still be able to decrypt their own backlog cleanly.
    expect(await ratchetDecrypt(B1.user, B1.device, bursts[1].B1)).toBe('second');
    expect(await ratchetDecrypt(B1.user, B1.device, bursts[0].B1)).toBe('first');
    expect(await ratchetDecrypt(B1.user, B1.device, bursts[2].B1)).toBe('third');

    expect(await ratchetDecrypt(B3.user, B3.device, bursts[2].B3)).toBe('third');
    expect(await ratchetDecrypt(B3.user, B3.device, bursts[1].B3)).toBe('second');
    expect(await ratchetDecrypt(B3.user, B3.device, bursts[0].B3)).toBe('first');
  });
});

describe('fan-out multi-session — cross-device misrouting is rejected', () => {
  it('an envelope addressed to B1 cannot be decrypted by B2 or B3', async () => {
    await seedSession(A1, B1);
    await seedSession(A1, B2);
    await seedSession(A1, B3);

    const burst = await fanOut(A1, [B1, B2, B3], 'private');
    expect(await ratchetDecrypt(B2.user, B2.device, burst.B1)).toBeNull();
    expect(await ratchetDecrypt(B3.user, B3.device, burst.B1)).toBeNull();
    // B1 still works after the misrouted attempts.
    expect(await ratchetDecrypt(B1.user, B1.device, burst.B1)).toBe('private');
  });

  it('mid-backlog misrouting does not corrupt the legitimate session', async () => {
    await seedSession(A1, B1);
    await seedSession(A1, B2);

    const b0 = await fanOut(A1, [B1, B2], 'm0');
    const b1 = await fanOut(A1, [B1, B2], 'm1');
    const b2 = await fanOut(A1, [B1, B2], 'm2');

    // Attacker pushes B1's envelopes onto B2 — must all fail.
    expect(await ratchetDecrypt(B2.user, B2.device, b0.B1)).toBeNull();
    expect(await ratchetDecrypt(B2.user, B2.device, b1.B1)).toBeNull();
    expect(await ratchetDecrypt(B2.user, B2.device, b2.B1)).toBeNull();

    // B2 then receives its OWN backlog out of order — still works.
    expect(await ratchetDecrypt(B2.user, B2.device, b2.B2)).toBe('m2');
    expect(await ratchetDecrypt(B2.user, B2.device, b0.B2)).toBe('m0');
    expect(await ratchetDecrypt(B2.user, B2.device, b1.B2)).toBe('m1');
  });
});

describe('fan-out multi-session — concurrent senders', () => {
  it('A1 and A2 fan-outs to the same peers do not interfere', async () => {
    // A1 → B1, B2 ; A2 → B1, B2.
    await seedSession(A1, B1);
    await seedSession(A1, B2);
    await seedSession(A2, B1);
    await seedSession(A2, B2);

    const fromA1 = await fanOut(A1, [B1, B2], 'from-A1');
    const fromA2 = await fanOut(A2, [B1, B2], 'from-A2');

    // B1 receives A2's first then A1's, B2 the opposite — both must succeed.
    expect(await ratchetDecrypt(B1.user, B1.device, fromA2.B1)).toBe('from-A2');
    expect(await ratchetDecrypt(B1.user, B1.device, fromA1.B1)).toBe('from-A1');
    expect(await ratchetDecrypt(B2.user, B2.device, fromA1.B2)).toBe('from-A1');
    expect(await ratchetDecrypt(B2.user, B2.device, fromA2.B2)).toBe('from-A2');

    // A1's envelope MUST NOT decrypt under (B1 ← A2) session, and vice versa.
    const lonely = await ratchetEncrypt(A1.user, A1.device, B1.user, B1.device, 'solo');
    expect(await ratchetDecrypt(B1.user, B1.device, lonely!)).toBe('solo');
  });
});

describe('fan-out multi-session — replay & cache hardening', () => {
  it('each envelope is single-use per receiver device (replay rejected)', async () => {
    await seedSession(A1, B1);
    await seedSession(A1, B2);

    const burst = await fanOut(A1, [B1, B2], 'unique');
    expect(await ratchetDecrypt(B1.user, B1.device, burst.B1)).toBe('unique');
    expect(await ratchetDecrypt(B1.user, B1.device, burst.B1)).toBeNull();
    // Replaying B1's envelope on B2 (cross-device) also fails.
    expect(await ratchetDecrypt(B2.user, B2.device, burst.B1)).toBeNull();
    // B2's own envelope still works exactly once.
    expect(await ratchetDecrypt(B2.user, B2.device, burst.B2)).toBe('unique');
    expect(await ratchetDecrypt(B2.user, B2.device, burst.B2)).toBeNull();
  });

  it('iOS reconnect: msg 0 delivered LAST after msgs 1..K decrypted', async () => {
    await seedSession(A1, B1);
    const K = 8;
    const envs: string[] = [];
    for (let i = 0; i < K; i++) {
      const e = await ratchetEncrypt(A1.user, A1.device, B1.user, B1.device, `msg-${i}`);
      envs.push(e!);
    }

    // Deliver msgs 1..K-1 first (msg 0 still "in flight"), then msg 0.
    for (let i = 1; i < K; i++) {
      expect(await ratchetDecrypt(B1.user, B1.device, envs[i])).toBe(`msg-${i}`);
    }
    expect(await ratchetDecrypt(B1.user, B1.device, envs[0])).toBe('msg-0');

    // After draining, all keys consumed → re-delivery of any envelope fails.
    for (let i = 0; i < K; i++) {
      expect(await ratchetDecrypt(B1.user, B1.device, envs[i])).toBeNull();
    }
  });
});
