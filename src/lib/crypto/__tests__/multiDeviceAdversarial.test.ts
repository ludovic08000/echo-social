/**
 * Adversarial multi-device E2EE tests.
 *
 * These are intentionally hostile inputs, not happy-path delivery:
 * forged v4 headers, malformed base64, wrong-session probes, and skip bombs.
 * The important invariant is that failed decrypt attempts must not persist
 * mutated ratchet state, otherwise a single bad packet can break the real
 * device session that follows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ratchetEncrypt,
  ratchetDecrypt,
  ratchetDecryptWithSession,
  clearAllDeviceSessions,
} from '../deviceRatchet';
import { hardCrypto } from '../cryptoIntegrity';
import { base64ToBuffer, bufferToBase64, randomBytes } from '../utils';

const DB_NAME = 'forsure-device-sessions';
const DB_VERSION = 2;
const STORE = 'sessions';
const RATCHET_PREFIX_V4 = 'x3dh4.';

interface Device {
  user: string;
  device: string;
}

interface SessionRecord {
  id: string;
  sessionId: string;
  rootKeyB64: string;
  dhsPrivJwk: JsonWebKey | null;
  dhsPubB64: string | null;
  dhrPubB64: string | null;
  ckSendB64: string | null;
  ckRecvB64: string | null;
  Ns: number;
  Nr: number;
  PN: number;
  skipped: Array<{ dhPubB64: string; n: number; keyB64: string }>;
  createdAt: number;
  peerSpkId: number;
}

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

async function putSession(record: SessionRecord): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function genX25519(): Promise<{ privJwk: JsonWebKey; pubB64: string }> {
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
    'jwk',
    privJwk,
    { name: 'X25519' } as any,
    true,
    ['deriveBits'],
  );
  const pub = await hardCrypto.importKey(
    'raw',
    base64ToBuffer(peerPubB64),
    { name: 'X25519' } as any,
    true,
    [],
  );
  return hardCrypto.deriveBits({ name: 'X25519', public: pub } as any, priv, 256);
}

async function kdfRK(rk32: ArrayBuffer, dhOut: ArrayBuffer): Promise<{ rk: string; ck: string }> {
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

async function seedSession(from: Device, to: Device, peerSpkId = 1): Promise<void> {
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
    Ns: 0,
    Nr: 0,
    PN: 0,
    skipped: [],
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
    Ns: 0,
    Nr: 0,
    PN: 0,
    skipped: [],
    createdAt: Date.now(),
    peerSpkId,
  });
}

function v4Parts(payload: string): string[] {
  expect(payload.startsWith(RATCHET_PREFIX_V4)).toBe(true);
  const parts = payload.slice(RATCHET_PREFIX_V4.length).split('.');
  expect(parts).toHaveLength(6);
  return parts;
}

function withV4Part(payload: string, index: number, value: string): string {
  const parts = v4Parts(payload);
  parts[index] = value;
  return `${RATCHET_PREFIX_V4}${parts.join('.')}`;
}

function flipCiphertextBit(payload: string): string {
  const parts = v4Parts(payload);
  const bytes = new Uint8Array(base64ToBuffer(parts[5]));
  expect(bytes.length).toBeGreaterThan(0);
  bytes[0] ^= 0x80;
  parts[5] = bufferToBase64(bytes.buffer as ArrayBuffer);
  return `${RATCHET_PREFIX_V4}${parts.join('.')}`;
}

const A1: Device = { user: 'alice', device: 'A1' };
const B1: Device = { user: 'bob', device: 'B1' };
const B2: Device = { user: 'bob', device: 'B2' };

beforeEach(async () => {
  await clearAllDeviceSessions();
});

describe('multi-device adversarial ratchet hardening', () => {
  it('rejects ciphertext bit flips without consuming receiver state', async () => {
    await seedSession(A1, B1);
    const env = await ratchetEncrypt(A1.user, A1.device, B1.user, B1.device, 'authentic-0');
    expect(env).not.toBeNull();

    expect(await ratchetDecrypt(B1.user, B1.device, flipCiphertextBit(env!))).toBeNull();
    expect(await ratchetDecrypt(B1.user, B1.device, env!)).toBe('authentic-0');

    const next = await ratchetEncrypt(A1.user, A1.device, B1.user, B1.device, 'authentic-1');
    expect(await ratchetDecrypt(B1.user, B1.device, next!)).toBe('authentic-1');
  });

  it('rejects a spoofed DH ratchet public key without poisoning the real session', async () => {
    await seedSession(A1, B1);
    const env = await ratchetEncrypt(A1.user, A1.device, B1.user, B1.device, 'legit-after-spoof');
    expect(env).not.toBeNull();

    const attackerKey = await genX25519();
    const forgedDhHeader = withV4Part(env!, 1, attackerKey.pubB64);

    expect(await ratchetDecrypt(B1.user, B1.device, forgedDhHeader)).toBeNull();
    expect(await ratchetDecrypt(B1.user, B1.device, env!)).toBe('legit-after-spoof');
  });

  it('rejects a future-message skip bomb without advancing Nr or filling skipped keys', async () => {
    await seedSession(A1, B1);
    const env = await ratchetEncrypt(A1.user, A1.device, B1.user, B1.device, 'first-real-message');
    expect(env).not.toBeNull();

    const skipBomb = withV4Part(env!, 2, '1000000');

    expect(await ratchetDecrypt(B1.user, B1.device, skipBomb)).toBeNull();
    expect(await ratchetDecrypt(B1.user, B1.device, env!)).toBe('first-real-message');
  });

  it('rejects malformed base64 in a routed v4 envelope without throwing', async () => {
    await seedSession(A1, B1);
    const env = await ratchetEncrypt(A1.user, A1.device, B1.user, B1.device, 'survives-bad-base64');
    expect(env).not.toBeNull();

    const malformedCiphertext = withV4Part(env!, 5, '%not-base64%');

    await expect(ratchetDecrypt(B1.user, B1.device, malformedCiphertext)).resolves.toBeNull();
    expect(await ratchetDecrypt(B1.user, B1.device, env!)).toBe('survives-bad-base64');
  });

  it('wrong-session fallback probes cannot corrupt the probed device session', async () => {
    await seedSession(A1, B1);
    await seedSession(A1, B2);

    const toB1 = await ratchetEncrypt(A1.user, A1.device, B1.user, B1.device, 'for-B1');
    const toB2 = await ratchetEncrypt(A1.user, A1.device, B2.user, B2.device, 'for-B2');
    expect(toB1).not.toBeNull();
    expect(toB2).not.toBeNull();

    expect(
      await ratchetDecryptWithSession(B2.user, B2.device, A1.user, A1.device, toB1!),
    ).toBeNull();

    expect(await ratchetDecrypt(B2.user, B2.device, toB2!)).toBe('for-B2');
    expect(await ratchetDecrypt(B1.user, B1.device, toB1!)).toBe('for-B1');
  });
});
