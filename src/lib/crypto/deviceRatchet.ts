/**
 * Device-pair Double Ratchet (Signal-style) — bidirectional with DH-ratchet.
 *
 * Provides:
 *   - Forward Secrecy (FS): each message key is derived once via KDF chain
 *     and immediately discarded (no key reuse).
 *   - Post-Compromise Security (PCS): every message ships a fresh ephemeral
 *     ratchet public key. When the peer replies with their own new ratchet
 *     key, the root key is re-derived via DH(newPriv, peerNewPub), healing
 *     past compromises.
 *   - Out-of-order delivery: skipped message keys are cached (bounded) so
 *     reordered messages still decrypt.
 *
 * Wire format:
 *   "x3dh5." sessionId "." dhPubB64 "." Ns "." PN "." ivB64 "." ctB64
 *     - dhPubB64 : sender's current ratchet public key (X25519)
 *     - Ns       : message number in current sending chain
 *     - PN       : length of previous sending chain (lets receiver skip keys)
 *
 * Sesame-lite accepts this authenticated v5 format only.
 *
 * Storage: IndexedDB `forsure-device-sessions` / `sessions`
 *   key   = `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`
 *   value = full DR state (root key, chains, counters, skipped keys)
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer, randomBytes, importKeyFromJWK, importOkpPublicKeyFromBase64 } from './utils';
import { logCryptoError } from './errorLogger';
import { exportPublicKeyRaw } from './keyManager';
import { runTxOn, reqToPromise } from './indexedDbTx';
import { RATCHET_MAX_SKIP, RATCHET_MAX_SKIPPED_CACHE } from './constants';
import { runDeviceSessionJob } from './deviceSessionQueue';

const STORE = 'sessions';

export const RATCHET_PREFIX_V5 = 'x3dh5.'; // Double Ratchet w/ DH + AAD (X3DH §3.3)

const AD_PREFIX_DEV_V5 = 'FORSURE-DEV-AD-v5|';
const AD_HEADER_PREFIX_DEV_V6 = 'FORSURE-DEV-HDR-v6|';
const HEADER_BOUND_SESSION_PREFIX = 's6';
const X25519_ALGORITHM: Algorithm = { name: 'X25519' };

// A bounded skipped-key window tolerates reordered delivery after mobile wake.
const MAX_SKIP = RATCHET_MAX_SKIP;            // max skipped message keys per chain
const MAX_SKIPPED_TOTAL = RATCHET_MAX_SKIPPED_CACHE;  // hard cap across all stored skipped keys

interface SkippedKey {
  /** dhPub (peer ratchet pub) of the chain the key belongs to, base64 */
  dhPubB64: string;
  /** message number in that chain */
  n: number;
  /** raw 32B AES key, base64 */
  keyB64: string;
}

interface StoredSession {
  id: string;
  sessionId: string;

  // Root chain
  rootKeyB64: string;            // 32 bytes
  // Our DH ratchet pair (X25519). Private exported as JWK for re-import.
  dhsPrivJwk: JsonWebKey | null; // null on receiver before first reply
  dhsPubB64: string | null;
  // Peer's latest DH ratchet public key (base64 raw)
  dhrPubB64: string | null;

  // Sending chain
  ckSendB64: string | null;      // 32 bytes
  Ns: number;
  // Receiving chain
  ckRecvB64: string | null;
  Nr: number;
  // Length of previous sending chain (for header)
  PN: number;

  skipped: SkippedKey[];
  createdAt: number;

  /**
   * SPK id of the peer device used at handshake time. When the peer rotates
   * its SignedPreKey, this no longer matches the latest bundle and the
   * session must be invalidated to force a fresh X3DH (see
   * `getSessionPeerSpkId` / `invalidateDeviceSession`).
   */
  peerSpkId?: number | null;

}

interface DecryptLogContext {
  peerUserId?: string;
  peerDeviceId?: string;
}

function compositeKey(myUserId: string, myDeviceId: string, peerUserId: string, peerDeviceId: string): string {
  return `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`;
}

function buildDevAAD(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  sessionId: string,
): Uint8Array {
  const me = `${myUserId}::${myDeviceId}`;
  const peer = `${peerUserId}::${peerDeviceId}`;
  const [a, b] = me < peer ? [me, peer] : [peer, me];
  return new hardGlobals.TextEncoder().encode(`${AD_PREFIX_DEV_V5}${sessionId}|${a}|${b}`);
}

function isHeaderBoundSession(sessionId: string): boolean {
  return sessionId.startsWith(HEADER_BOUND_SESSION_PREFIX);
}

function buildDevAADWithHeader(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  sessionId: string,
  header: { dh: string; pn: number; n: number },
): Uint8Array {
  const identityAd = buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, sessionId);
  const headerAd = new hardGlobals.TextEncoder().encode(
    `${AD_HEADER_PREFIX_DEV_V6}${header.dh}|${header.pn}|${header.n}`,
  );
  const out = new Uint8Array(identityAd.byteLength + headerAd.byteLength);
  out.set(identityAd, 0);
  out.set(headerAd, identityAd.byteLength);
  return out;
}

function parseCompositeKey(key: string): { myUserId: string; myDeviceId: string; peerUserId: string; peerDeviceId: string } | null {
  const parts = key.split('::');
  if (parts.length !== 4) return null;
  return { myUserId: parts[0], myDeviceId: parts[1], peerUserId: parts[2], peerDeviceId: parts[3] };
}

async function loadSession(key: string): Promise<StoredSession | null> {
  try {
    const result = await runTxOn('device-sessions', [STORE], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(STORE).get(key) as IDBRequest<StoredSession | undefined>),
    );
    return result ?? null;
  } catch {
    return null;
  }
}

async function saveSession(key: string, session: StoredSession): Promise<void> {
  await runTxOn('device-sessions', [STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).put({ ...session, id: key });
  });
}

async function lookupSessionById(
  myUserId: string,
  myDeviceId: string,
  sessionId: string,
): Promise<{ key: string; session: StoredSession } | null> {
  try {
    const all = await runTxOn('device-sessions', [STORE], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(STORE).getAll() as IDBRequest<StoredSession[]>),
    );
    const prefix = `${myUserId}::${myDeviceId}::`;
    for (const s of all ?? []) {
      if (s.sessionId === sessionId && s.id.startsWith(prefix)) {
        return { key: s.id, session: s };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function hkdf(ikm: ArrayBuffer, salt: ArrayBuffer, info: string, lenBits: number): Promise<ArrayBuffer> {
  const baseKey = await hardCrypto.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return hardCrypto.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info: new hardGlobals.TextEncoder().encode(info),
    },
    baseKey,
    lenBits,
  );
}

async function kdfRK(rkB64: string, dhOut: ArrayBuffer): Promise<{ rk: string; ck: string }> {
  const out = await hkdf(dhOut, base64ToBuffer(rkB64), 'ForSureDR:RootKey', 512);
  const u8 = new Uint8Array(out);
  return {
    rk: bufferToBase64(u8.slice(0, 32).buffer as ArrayBuffer),
    ck: bufferToBase64(u8.slice(32, 64).buffer as ArrayBuffer),
  };
}

async function kdfCK(ckB64: string): Promise<{ ck: string; mk: string }> {
  const ckBuf = base64ToBuffer(ckB64);
  const hmacKey = await hardCrypto.importKey(
    'raw', ckBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mk = await hardCrypto.sign({ name: 'HMAC' }, hmacKey, new Uint8Array([0x01]));
  const ck = await hardCrypto.sign({ name: 'HMAC' }, hmacKey, new Uint8Array([0x02]));
  return {
    mk: bufferToBase64(mk),
    ck: bufferToBase64(ck),
  };
}

async function importMessageKey(mkB64: string): Promise<CryptoKey> {
  return hardCrypto.importKey(
    'raw', base64ToBuffer(mkB64), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function generateRatchetKeyPair(): Promise<{ priv: CryptoKey; privJwk: JsonWebKey; pubB64: string }> {
  const kp = await hardCrypto.generateKey(X25519_ALGORITHM, true, ['deriveBits']) as CryptoKeyPair;
  const privJwk = await hardCrypto.exportKey('jwk', kp.privateKey);
  const pubRaw = await exportPublicKeyRaw(kp.publicKey);
  return { priv: kp.privateKey, privJwk, pubB64: bufferToBase64(pubRaw) };
}

async function importPriv(jwk: JsonWebKey): Promise<CryptoKey> {
  return importKeyFromJWK(jwk, X25519_ALGORITHM, ['deriveBits'], true);
}

async function importPub(b64: string): Promise<CryptoKey> {
  return importOkpPublicKeyFromBase64(b64, 'X25519', [], true);
}

async function dh(privJwk: JsonWebKey, peerPubB64: string): Promise<ArrayBuffer> {
  const priv = await importPriv(privJwk);
  const pub = await importPub(peerPubB64);
  const algorithm: Algorithm & { public: CryptoKey } = { name: 'X25519', public: pub };
  return hardCrypto.deriveBits(algorithm, priv, 256);
}

async function dhRatchet(session: StoredSession, peerNewPubB64: string): Promise<StoredSession> {
  const newPN = session.Ns;
  let s: StoredSession = { ...session, PN: newPN, Ns: 0, Nr: 0 };

  if (s.dhsPrivJwk) {
    const dhOut1 = await dh(s.dhsPrivJwk, peerNewPubB64);
    const r1 = await kdfRK(s.rootKeyB64, dhOut1);
    s = { ...s, rootKeyB64: r1.rk, ckRecvB64: r1.ck, dhrPubB64: peerNewPubB64 };
  } else {
    s = { ...s, dhrPubB64: peerNewPubB64 };
  }

  const fresh = await generateRatchetKeyPair();
  const dhOut2 = await dh(fresh.privJwk, peerNewPubB64);
  const r2 = await kdfRK(s.rootKeyB64, dhOut2);
  s = {
    ...s,
    rootKeyB64: r2.rk,
    ckSendB64: r2.ck,
    dhsPrivJwk: fresh.privJwk,
    dhsPubB64: fresh.pubB64,
  };
  return s;
}

async function trySkippedKeys(
  session: StoredSession,
  dhPubB64: string,
  n: number,
  iv: Uint8Array,
  ct: ArrayBuffer,
  aad: Uint8Array,
): Promise<{ pt: string; updated: StoredSession } | null> {
  const idx = session.skipped.findIndex(s => s.dhPubB64 === dhPubB64 && s.n === n);
  if (idx === -1) return null;
  const entry = session.skipped[idx];
  try {
    const aes = await importMessageKey(entry.keyB64);
    const ivCopy = new Uint8Array(iv.byteLength);
    ivCopy.set(iv);
    const ctCopy = (ct as ArrayBuffer).slice(0);
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: ivCopy as Uint8Array<ArrayBuffer>, tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> } as AesGcmParams,
      aes,
      ctCopy,
    );
    const newSkipped = session.skipped.slice();
    newSkipped.splice(idx, 1);
    return {
      pt: new hardGlobals.TextDecoder().decode(pt),
      updated: { ...session, skipped: newSkipped },
    };
  } catch {
    return null;
  }
}

async function skipMessageKeys(session: StoredSession, until: number): Promise<StoredSession> {
  if (session.ckRecvB64 === null) return session;
  if (session.Nr + MAX_SKIP < until) {
    throw new Error('too_many_skipped');
  }
  const s = { ...session, skipped: [...session.skipped] };
  while (s.Nr < until) {
    const { ck, mk } = await kdfCK(s.ckRecvB64!);
    s.skipped.push({ dhPubB64: s.dhrPubB64!, n: s.Nr, keyB64: mk });
    s.ckRecvB64 = ck;
    s.Nr += 1;
  }
  if (s.skipped.length > MAX_SKIPPED_TOTAL) {
    s.skipped = s.skipped.slice(s.skipped.length - MAX_SKIPPED_TOTAL);
  }
  return s;
}

async function establishDeviceSessionUnlocked(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  sharedSecret: ArrayBuffer,
  sessionId?: string,
  opts?: {
    peerInitialDhPubB64?: string | null;
    isInitiator?: boolean;
    peerSpkId?: number | null;
    selfInitialDhPrivJwk?: JsonWebKey | null;
    selfInitialDhPubB64?: string | null;
  },
): Promise<string> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  const finalSessionId =
    sessionId ?? `${HEADER_BOUND_SESSION_PREFIX}${bufferToBase64(randomBytes(8).buffer as ArrayBuffer).replace(/[+/=]/g, '').slice(0, 10)}`;
  const ss32 = sharedSecret.byteLength >= 32 ? sharedSecret.slice(0, 32) : sharedSecret;
  const rootKeyB64 = bufferToBase64(ss32);

  let session: StoredSession = {
    id: key,
    sessionId: finalSessionId,
    rootKeyB64,
    dhsPrivJwk: opts?.selfInitialDhPrivJwk ?? null,
    dhsPubB64: opts?.selfInitialDhPubB64 ?? null,
    dhrPubB64: opts?.peerInitialDhPubB64 ?? null,
    ckSendB64: null,
    ckRecvB64: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    skipped: [],
    createdAt: Date.now(),
    peerSpkId: opts?.peerSpkId ?? null,
  };

  if (opts?.isInitiator && opts.peerInitialDhPubB64) {
    const fresh = await generateRatchetKeyPair();
    const dhOut = await dh(fresh.privJwk, opts.peerInitialDhPubB64);
    const r = await kdfRK(session.rootKeyB64, dhOut);
    session = {
      ...session,
      rootKeyB64: r.rk,
      ckSendB64: r.ck,
      dhsPrivJwk: fresh.privJwk,
      dhsPubB64: fresh.pubB64,
    };
  }

  await saveSession(key, session);
  return finalSessionId;
}

export async function establishDeviceSession(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  sharedSecret: ArrayBuffer,
  sessionId?: string,
  opts?: {
    peerInitialDhPubB64?: string | null;
    isInitiator?: boolean;
    peerSpkId?: number | null;
    selfInitialDhPrivJwk?: JsonWebKey | null;
    selfInitialDhPubB64?: string | null;
  },
): Promise<string> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  return runDeviceSessionJob('ratchet', key, () => establishDeviceSessionUnlocked(
    myUserId,
    myDeviceId,
    peerUserId,
    peerDeviceId,
    sharedSecret,
    sessionId,
    opts,
  ));
}

async function ratchetEncryptUnlocked(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  plaintext: string,
): Promise<string | null> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  const session = await loadSession(key);
  if (!session) {
    void logCryptoError({
      severity: 'info',
      context: 'encrypt',
      errorCode: 'E_NO_SESSION',
      errorMessage: 'No device-pair session — caller must run X3DH',
      myDeviceId, peerUserId, peerDeviceId,
    });
    return null;
  }

  if (!session.ckSendB64 || !session.dhsPubB64) {
    void logCryptoError({
      severity: 'info',
      context: 'encrypt',
      errorCode: 'E_NO_SEND_CHAIN',
      errorMessage: 'Responder ratchet not yet primed (awaiting first reply)',
      myDeviceId, peerUserId, peerDeviceId,
    });
    return null;
  }

  const { ck, mk } = await kdfCK(session.ckSendB64);
  const aes = await importMessageKey(mk);
  const iv = randomBytes(12);
  const Ns = session.Ns;
  const header = { dh: session.dhsPubB64, pn: session.PN, n: Ns };
  const aad = isHeaderBoundSession(session.sessionId)
    ? buildDevAADWithHeader(myUserId, myDeviceId, peerUserId, peerDeviceId, session.sessionId, header)
    : buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, session.sessionId);
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> },
    aes,
    new hardGlobals.TextEncoder().encode(plaintext),
  );
  await saveSession(key, { ...session, ckSendB64: ck, Ns: Ns + 1 });

  return [
    RATCHET_PREFIX_V5 + session.sessionId,
    session.dhsPubB64,
    String(Ns),
    String(session.PN),
    bufferToBase64(iv.buffer as ArrayBuffer),
    bufferToBase64(ct as ArrayBuffer),
  ].join('.');
}

export async function ratchetEncrypt(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  plaintext: string,
): Promise<string | null> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  return runDeviceSessionJob('ratchet', key, () => ratchetEncryptUnlocked(
    myUserId,
    myDeviceId,
    peerUserId,
    peerDeviceId,
    plaintext,
  ));
}

export async function ratchetDecrypt(
  myUserId: string,
  myDeviceId: string,
  payload: string,
): Promise<string | null> {
  if (!payload.startsWith(RATCHET_PREFIX_V5)) return null;
  const parts = payload.slice(RATCHET_PREFIX_V5.length).split('.');
  if (parts.length !== 6 || !parts[0]) return null;
  const found = await lookupSessionById(myUserId, myDeviceId, parts[0]);
  if (!found) return null;
  return runDeviceSessionJob('ratchet', found.key, () => decryptV5(myUserId, myDeviceId, payload));
}

async function decryptV5(
  myUserId: string,
  myDeviceId: string,
  payload: string,
): Promise<string | null> {
  const parts = payload.slice(RATCHET_PREFIX_V5.length).split('.');
  if (parts.length !== 6) return null;
  const [sessionId] = parts;
  const found = await lookupSessionById(myUserId, myDeviceId, sessionId);
  if (!found) return null;
  const peer = parseCompositeKey(found.key);
  if (!peer) return null;
  const headerBound = isHeaderBoundSession(sessionId);
  const header = { dh: parts[1], n: Number(parts[2]), pn: Number(parts[3]) };
  if (headerBound && (!Number.isSafeInteger(header.n) || !Number.isSafeInteger(header.pn))) return null;
  const aad = headerBound
    ? buildDevAADWithHeader(peer.myUserId, peer.myDeviceId, peer.peerUserId, peer.peerDeviceId, sessionId, header)
    : buildDevAAD(peer.myUserId, peer.myDeviceId, peer.peerUserId, peer.peerDeviceId, sessionId);
  return decryptV5WithStored(found.key, found.session, parts, aad, peer);
}

async function ratchetDecryptWithSessionUnlocked(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  payload: string,
): Promise<string | null> {
  if (!payload.startsWith(RATCHET_PREFIX_V5)) return null;
  const parts = payload.slice(RATCHET_PREFIX_V5.length).split('.');
  if (parts.length !== 6) return null;
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  const session = await loadSession(key);
  if (!session) return null;
  const headerBound = isHeaderBoundSession(parts[0]);
  const header = { dh: parts[1], n: Number(parts[2]), pn: Number(parts[3]) };
  if (headerBound && (!Number.isSafeInteger(header.n) || !Number.isSafeInteger(header.pn))) return null;
  const aad = headerBound
    ? buildDevAADWithHeader(myUserId, myDeviceId, peerUserId, peerDeviceId, parts[0], header)
    : buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, parts[0]);
  return decryptV5WithStored(key, session, parts, aad, { peerUserId, peerDeviceId });
}

export async function ratchetDecryptWithSession(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  payload: string,
): Promise<string | null> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  return runDeviceSessionJob('ratchet', key, () => ratchetDecryptWithSessionUnlocked(
    myUserId,
    myDeviceId,
    peerUserId,
    peerDeviceId,
    payload,
  ));
}

async function decryptV5WithStored(
  key: string,
  initialSession: StoredSession,
  parts: string[],
  aad: Uint8Array,
  logContext: DecryptLogContext = {},
): Promise<string | null> {
  const [sessionId, dhPubB64, NsStr, PNStr, ivB64, ctB64] = parts;
  const Ns = parseInt(NsStr, 10);
  const PN = parseInt(PNStr, 10);
  if (Number.isNaN(Ns) || Number.isNaN(PN)) return null;

  let session = initialSession;
  const iv = new Uint8Array(base64ToBuffer(ivB64));
  const ct = base64ToBuffer(ctB64);

  const skipped = await trySkippedKeys(session, dhPubB64, Ns, iv, ct, aad);
  if (skipped) {
    await saveSession(key, skipped.updated);
    return skipped.pt;
  }

  try {
    if (session.dhrPubB64 !== dhPubB64) {
      session = await skipMessageKeys(session, PN);
      session = await dhRatchet(session, dhPubB64);
    }
    session = await skipMessageKeys(session, Ns);

    const { ck, mk } = await kdfCK(session.ckRecvB64!);
    const aes = await importMessageKey(mk);
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> } as AesGcmParams,
      aes,
      ct,
    );
    session = { ...session, ckRecvB64: ck, Nr: session.Nr + 1 };
    await saveSession(key, session);
    return new hardGlobals.TextDecoder().decode(pt);
  } catch (err) {
    void logCryptoError({
      severity: 'error',
      context: 'decrypt',
      errorCode: 'E_DECRYPT_V5',
      errorMessage: err instanceof Error ? err.message : String(err),
      myDeviceId: key.split('::')[1] ?? 'unknown',
      peerUserId: logContext.peerUserId,
      peerDeviceId: logContext.peerDeviceId,
      metadata: { sessionId, Ns, PN },
    });
    return null;
  }
}

export async function getSessionPeerSpkId(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
): Promise<number | null> {
  const session = await loadSession(compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId));
  return session?.peerSpkId ?? null;
}

async function invalidateDeviceSessionUnlocked(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
): Promise<void> {
  try {
    await runTxOn('device-sessions', [STORE], 'readwrite', (tx) => {
      tx.objectStore(STORE).delete(compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId));
    });
  } catch {
    // non-fatal
  }
}

export async function invalidateDeviceSession(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
): Promise<void> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  await runDeviceSessionJob('ratchet', key, () => invalidateDeviceSessionUnlocked(
    myUserId,
    myDeviceId,
    peerUserId,
    peerDeviceId,
  ));
}

export async function listKnownSessionIds(
  myUserId: string,
  myDeviceId: string,
): Promise<Array<{ peerUserId: string; peerDeviceId: string; sessionId: string; lastUsedAt: number }>> {
  try {
    const all = await runTxOn('device-sessions', [STORE], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(STORE).getAll() as IDBRequest<StoredSession[]>),
    );
    const prefix = `${myUserId}::${myDeviceId}::`;
    const out: Array<{ peerUserId: string; peerDeviceId: string; sessionId: string; lastUsedAt: number }> = [];
    for (const s of all ?? []) {
      if (!s.id.startsWith(prefix)) continue;
      const parts = s.id.split('::');
      if (parts.length < 4) continue;
      out.push({
        peerUserId: parts[2],
        peerDeviceId: parts[3],
        sessionId: s.sessionId,
        lastUsedAt: (s as unknown as { lastUsedAt?: number }).lastUsedAt ?? 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function clearAllDeviceSessions(): Promise<void> {
  try {
    await runTxOn('device-sessions', [STORE], 'readwrite', (tx) => {
      tx.objectStore(STORE).clear();
    });
  } catch {
    // non-fatal
  }
}
