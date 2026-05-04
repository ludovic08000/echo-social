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
 * Wire format (v4):
 *   "x3dh4." sessionId "." dhPubB64 "." Ns "." PN "." ivB64 "." ctB64
 *     - dhPubB64 : sender's current ratchet public key (X25519)
 *     - Ns       : message number in current sending chain
 *     - PN       : length of previous sending chain (lets receiver skip keys)
 *
 * Backwards-compat: prefix `x3dh3.` (single shared-secret HKDF) is still
 * decoded so existing in-flight v3 messages keep working until sessions are
 * naturally re-established.
 *
 * Storage: IndexedDB `forsure-device-sessions` / `sessions`
 *   key   = `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`
 *   value = full DR state (root key, chains, counters, skipped keys)
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer, randomBytes, importKeyFromJWK, importOkpPublicKeyFromBase64 } from './utils';
import { logCryptoError } from './errorLogger';
import { exportPublicKeyRaw } from './keyManager';

const DB_NAME = 'forsure-device-sessions';
const DB_VERSION = 2;
const STORE = 'sessions';

export const RATCHET_PREFIX_V3 = 'x3dh3.'; // legacy (single-secret KDF)
export const RATCHET_PREFIX_V4 = 'x3dh4.'; // Double Ratchet w/ DH

const MAX_SKIP = 256;            // max skipped message keys per chain
const MAX_SKIPPED_TOTAL = 2048;  // hard cap across all stored skipped keys

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

  // Legacy v3 fallback (kept for already-established sessions)
  legacySharedSecretB64?: string | null;
  legacySendCounter?: number;
  legacyRecvCounter?: number;
}

// ─── IndexedDB helpers ──────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = hardGlobals.idbOpen(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
  });
}

function compositeKey(myUserId: string, myDeviceId: string, peerUserId: string, peerDeviceId: string): string {
  return `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`;
}

async function loadSession(key: string): Promise<StoredSession | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    return await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as StoredSession) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function saveSession(key: string, session: StoredSession): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...session, id: key });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // non-fatal
  }
}

async function lookupSessionById(
  myUserId: string,
  myDeviceId: string,
  sessionId: string,
): Promise<{ key: string; session: StoredSession } | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    const all = await new Promise<StoredSession[]>((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as StoredSession[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${myUserId}::${myDeviceId}::`;
    for (const s of all) {
      if (s.sessionId === sessionId && s.id.startsWith(prefix)) {
        return { key: s.id, session: s };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Crypto primitives ──────────────────────────────────────────────────────

async function hkdf(ikm: ArrayBuffer, salt: ArrayBuffer, info: string, lenBits: number): Promise<ArrayBuffer> {
  const baseKey = await hardCrypto.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return hardCrypto.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info: new hardGlobals.TextEncoder().encode(info),
    } as any,
    baseKey,
    lenBits,
  );
}

/** KDF_RK(rk, dh_out) -> (rk', ck) — Signal spec. */
async function kdfRK(rkB64: string, dhOut: ArrayBuffer): Promise<{ rk: string; ck: string }> {
  const out = await hkdf(dhOut, base64ToBuffer(rkB64), 'ForSureDR:RootKey', 512);
  const u8 = new Uint8Array(out);
  return {
    rk: bufferToBase64(u8.slice(0, 32).buffer as ArrayBuffer),
    ck: bufferToBase64(u8.slice(32, 64).buffer as ArrayBuffer),
  };
}

/** KDF_CK(ck) -> (ck', mk) using HMAC-SHA256 with constants 0x01 (mk) and 0x02 (ck). */
async function kdfCK(ckB64: string): Promise<{ ck: string; mk: string }> {
  const ckBuf = base64ToBuffer(ckB64);
  const hmacKey = await hardCrypto.importKey(
    'raw', ckBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sign = (hardCrypto as any).sign as (alg: any, key: CryptoKey, data: BufferSource) => Promise<ArrayBuffer>;
  const mk = await sign({ name: 'HMAC' }, hmacKey, new Uint8Array([0x01]));
  const ck = await sign({ name: 'HMAC' }, hmacKey, new Uint8Array([0x02]));
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
  const kp = await hardCrypto.generateKey({ name: 'X25519' } as any, true, ['deriveBits']) as CryptoKeyPair;
  const privJwk = await hardCrypto.exportKey('jwk', kp.privateKey);
  const pubRaw = await exportPublicKeyRaw(kp.publicKey);
  return { priv: kp.privateKey, privJwk, pubB64: bufferToBase64(pubRaw) };
}

async function importPriv(jwk: JsonWebKey): Promise<CryptoKey> {
  return importKeyFromJWK(jwk, { name: 'X25519' } as any, ['deriveBits'], true);
}

async function importPub(b64: string): Promise<CryptoKey> {
  return importOkpPublicKeyFromBase64(b64, 'X25519', [], true);
}

async function dh(privJwk: JsonWebKey, peerPubB64: string): Promise<ArrayBuffer> {
  const priv = await importPriv(privJwk);
  const pub = await importPub(peerPubB64);
  return hardCrypto.deriveBits({ name: 'X25519', public: pub } as any, priv, 256);
}

// ─── DH-ratchet step ────────────────────────────────────────────────────────

/** Receiver-side DH-ratchet: peer sent a new ratchet pub. Updates root + chains. */
async function dhRatchet(session: StoredSession, peerNewPubB64: string): Promise<StoredSession> {
  // Save current sending chain length, then derive new receiving chain from peer's new pub.
  const newPN = session.Ns;
  let s: StoredSession = { ...session, PN: newPN, Ns: 0, Nr: 0 };

  if (s.dhsPrivJwk) {
    const dhOut1 = await dh(s.dhsPrivJwk, peerNewPubB64);
    const r1 = await kdfRK(s.rootKeyB64, dhOut1);
    s = { ...s, rootKeyB64: r1.rk, ckRecvB64: r1.ck, dhrPubB64: peerNewPubB64 };
  } else {
    // First-ever ratchet on this side: just remember peer pub, generate our pair below.
    s = { ...s, dhrPubB64: peerNewPubB64 };
  }

  // Generate fresh local ratchet pair and derive new sending chain.
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

// ─── Skipped-key cache ──────────────────────────────────────────────────────

async function trySkippedKeys(
  session: StoredSession,
  dhPubB64: string,
  n: number,
  iv: Uint8Array,
  ct: ArrayBuffer,
): Promise<{ pt: string; updated: StoredSession } | null> {
  const idx = session.skipped.findIndex(s => s.dhPubB64 === dhPubB64 && s.n === n);
  if (idx === -1) return null;
  const entry = session.skipped[idx];
  try {
    const aes = await importMessageKey(entry.keyB64);
    // Defensive copy of IV + ciphertext: WebCrypto implementations are free to
    // detach or otherwise mutate the underlying buffer. If decryption fails we
    // must keep the originals intact for the next attempt path.
    const ivCopy = new Uint8Array(iv.byteLength);
    ivCopy.set(iv);
    const ctCopy = (ct as ArrayBuffer).slice(0);
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: ivCopy as Uint8Array<ArrayBuffer>, tagLength: 128 }, aes, ctCopy,
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
  let s = { ...session, skipped: [...session.skipped] };
  while (s.Nr < until) {
    const { ck, mk } = await kdfCK(s.ckRecvB64!);
    s.skipped.push({ dhPubB64: s.dhrPubB64!, n: s.Nr, keyB64: mk });
    s.ckRecvB64 = ck;
    s.Nr += 1;
  }
  // Trim if global skipped budget exceeded (drop oldest).
  if (s.skipped.length > MAX_SKIPPED_TOTAL) {
    s.skipped = s.skipped.slice(s.skipped.length - MAX_SKIPPED_TOTAL);
  }
  return s;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Establish a new device-pair session from a freshly negotiated X3DH secret.
 * Initiator passes `peerInitialDhPubB64` (peer's signed prekey acts as their
 * initial ratchet pub); responder leaves it null until the first inbound
 * message reveals the initiator's ratchet pub.
 */
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
    /**
     * Responder priming: seed the local DH ratchet pair with the device SPK
     * keypair so the very first inbound v4 message can complete a DH-ratchet
     * step (DH(SPK_priv, initiatorRatchetPub)). Without this, the responder
     * stays unable to encrypt and every reply triggers a fresh X3DH burst.
     */
    selfInitialDhPrivJwk?: JsonWebKey | null;
    selfInitialDhPubB64?: string | null;
  },
): Promise<string> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  const finalSessionId =
    sessionId ?? bufferToBase64(randomBytes(8).buffer as ArrayBuffer).replace(/[+/=]/g, '').slice(0, 12);
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

  // Initiator immediately runs a DH-ratchet step against the peer's initial
  // pub so the very first outbound message carries a fresh ratchet key.
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

/**
 * Encrypt with the device-pair ratchet. Returns null if no session — caller
 * must fall back to X3DH (and then call `establishDeviceSession`).
 */
export async function ratchetEncrypt(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  plaintext: string,
): Promise<string | null> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  let session = await loadSession(key);
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

  // Legacy v3 session — keep using it (no DH key material to upgrade safely).
  if (session.legacySharedSecretB64 && !session.ckSendB64 && !session.dhsPubB64) {
    return legacyEncryptV3(key, session, plaintext);
  }

  // If we have no sending chain yet (e.g. responder before its first reply),
  // we cannot encrypt under DR yet → signal caller to fall back to X3DH.
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
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    aes,
    new hardGlobals.TextEncoder().encode(plaintext),
  );

  const Ns = session.Ns;
  await saveSession(key, { ...session, ckSendB64: ck, Ns: Ns + 1 });

  return [
    RATCHET_PREFIX_V4 + session.sessionId,
    session.dhsPubB64,
    String(Ns),
    String(session.PN),
    bufferToBase64(iv.buffer as ArrayBuffer),
    bufferToBase64(ct as ArrayBuffer),
  ].join('.');
}

/**
 * Decrypt a v3 (legacy) or v4 (DR) envelope.
 */
export async function ratchetDecrypt(
  myUserId: string,
  myDeviceId: string,
  payload: string,
): Promise<string | null> {
  if (payload.startsWith(RATCHET_PREFIX_V4)) {
    return decryptV4(myUserId, myDeviceId, payload);
  }
  if (payload.startsWith(RATCHET_PREFIX_V3)) {
    return decryptV3(myUserId, myDeviceId, payload);
  }
  return null;
}

async function decryptV4(myUserId: string, myDeviceId: string, payload: string): Promise<string | null> {
  const parts = payload.slice(RATCHET_PREFIX_V4.length).split('.');
  if (parts.length !== 6) return null;
  const [sessionId] = parts;
  const found = await lookupSessionById(myUserId, myDeviceId, sessionId);
  if (!found) return null;
  return decryptV4WithStored(found.key, found.session, parts);
}

/**
 * Public escape hatch: attempt v4 decryption against a *specific* locally
 * stored session, ignoring the sessionId in the payload header. Used by the
 * multi-session fallback router when the header sessionId points to an
 * unknown / rotated session but the peer still has a valid prior session
 * locally that may decrypt the message (e.g. multi-device peer where one
 * device's session was bootstrapped under a different sessionId).
 *
 * Returns null on parse failure or AES-GCM tag mismatch — never throws.
 */
export async function ratchetDecryptWithSession(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  payload: string,
): Promise<string | null> {
  if (!payload.startsWith(RATCHET_PREFIX_V4)) {
    // v3 has no DH state to ratchet — re-route through the standard path.
    if (payload.startsWith(RATCHET_PREFIX_V3)) {
      const parts = payload.slice(RATCHET_PREFIX_V3.length).split('.');
      if (parts.length !== 4) return null;
      const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
      const session = await loadSession(key);
      if (!session) return null;
      return decryptV3WithStored(key, session, parts);
    }
    return null;
  }
  const parts = payload.slice(RATCHET_PREFIX_V4.length).split('.');
  if (parts.length !== 6) return null;
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  const session = await loadSession(key);
  if (!session) return null;
  return decryptV4WithStored(key, session, parts);
}

/**
 * Core v4 decrypt loop, factored out so both header-routed and
 * session-forced callers share the exact same crypto path.
 *
 * IMPORTANT: state is only persisted on full success. Probe attempts that
 * fail (wrong session, AES tag mismatch) leave IndexedDB untouched, which
 * is what makes session-by-session probing safe.
 */
async function decryptV4WithStored(
  key: string,
  initialSession: StoredSession,
  parts: string[],
): Promise<string | null> {
  const [sessionId, dhPubB64, NsStr, PNStr, ivB64, ctB64] = parts;
  const Ns = parseInt(NsStr, 10);
  const PN = parseInt(PNStr, 10);
  if (Number.isNaN(Ns) || Number.isNaN(PN)) return null;

  let session = initialSession;
  const iv = new Uint8Array(base64ToBuffer(ivB64));
  const ct = base64ToBuffer(ctB64);

  // 1) Skipped-key fast path
  const skipped = await trySkippedKeys(session, dhPubB64, Ns, iv, ct);
  if (skipped) {
    await saveSession(key, skipped.updated);
    return skipped.pt;
  }

  try {
    // 2) DH-ratchet step if peer rotated their key
    if (session.dhrPubB64 !== dhPubB64) {
      session = await skipMessageKeys(session, PN);
      session = await dhRatchet(session, dhPubB64);
    }
    // 3) Skip up to Ns in current receiving chain
    session = await skipMessageKeys(session, Ns);

    // 4) Derive next message key
    const { ck, mk } = await kdfCK(session.ckRecvB64!);
    const aes = await importMessageKey(mk);
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 }, aes, ct,
    );
    session = { ...session, ckRecvB64: ck, Nr: session.Nr + 1 };
    await saveSession(key, session);
    return new hardGlobals.TextDecoder().decode(pt);
  } catch (err) {
    void logCryptoError({
      severity: 'error',
      context: 'decrypt',
      errorCode: 'E_DECRYPT_V4',
      errorMessage: err instanceof Error ? err.message : String(err),
      myDeviceId: key.split('::')[1] ?? 'unknown',
      metadata: { sessionId, Ns, PN },
    });
    return null;
  }
}

// ─── Legacy v3 fallback (keeps in-flight messages decryptable) ──────────────

async function legacyEncryptV3(key: string, session: StoredSession, plaintext: string): Promise<string | null> {
  if (!session.legacySharedSecretB64) return null;
  const counter = session.legacySendCounter ?? 0;
  const ikm = await hardCrypto.importKey(
    'raw', base64ToBuffer(session.legacySharedSecretB64), 'HKDF', false, ['deriveBits'],
  );
  const info = new hardGlobals.TextEncoder().encode(`ForSureDevRatchet:${counter}`);
  const bits = await hardCrypto.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info } as any, ikm, 256,
  );
  const aes = await hardCrypto.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = randomBytes(12);
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    aes,
    new hardGlobals.TextEncoder().encode(plaintext),
  );
  await saveSession(key, { ...session, legacySendCounter: counter + 1 });
  return [
    RATCHET_PREFIX_V3 + session.sessionId,
    String(counter),
    bufferToBase64(iv.buffer as ArrayBuffer),
    bufferToBase64(ct as ArrayBuffer),
  ].join('.');
}

async function decryptV3(myUserId: string, myDeviceId: string, payload: string): Promise<string | null> {
  const parts = payload.slice(RATCHET_PREFIX_V3.length).split('.');
  if (parts.length !== 4) return null;
  const [sessionId] = parts;
  const found = await lookupSessionById(myUserId, myDeviceId, sessionId);
  if (!found || !found.session.legacySharedSecretB64) return null;
  return decryptV3WithStored(found.key, found.session, parts);
}

async function decryptV3WithStored(
  key: string,
  session: StoredSession,
  parts: string[],
): Promise<string | null> {
  const [, counterStr, ivB64, ctB64] = parts;
  const counter = parseInt(counterStr, 10);
  if (Number.isNaN(counter) || !session.legacySharedSecretB64) return null;
  try {
    const ikm = await hardCrypto.importKey(
      'raw', base64ToBuffer(session.legacySharedSecretB64), 'HKDF', false, ['deriveBits'],
    );
    const info = new hardGlobals.TextEncoder().encode(`ForSureDevRatchet:${counter}`);
    const bits = await hardCrypto.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info } as any, ikm, 256,
    );
    const aes = await hardCrypto.importKey(
      'raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(ivB64)), tagLength: 128 },
      aes,
      base64ToBuffer(ctB64),
    );
    if (counter >= (session.legacyRecvCounter ?? 0)) {
      await saveSession(key, { ...session, legacyRecvCounter: counter + 1 });
    }
    return new hardGlobals.TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/**
 * Returns the SPK id of the peer device used at handshake time, or null if
 * the session is unknown / pre-tracking. Callers compare this with the
 * latest published bundle to detect peer-side rotation.
 */
export async function getSessionPeerSpkId(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
): Promise<number | null> {
  const session = await loadSession(compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId));
  return session?.peerSpkId ?? null;
}

/**
 * Drop the session for ONE peer device. Used when we detect that the peer
 * has rotated its SignedPreKey: the cached root/chain keys are no longer
 * derivable on the peer side, so any further v3/v4 message would silently
 * fail to decrypt. Forcing re-X3DH heals the link.
 *
 * SECURITY: do NOT call this automatically as an "error recovery" hack.
 * Active sessions may be required to decrypt in-flight messages from the
 * pending queue. Only call when:
 *   - the peer has demonstrably rotated SPK (see multiDeviceFanout)
 *   - the user explicitly resets the chat from settings
 *   - a verified key restore from backup is in progress
 */
export async function invalidateDeviceSession(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // non-fatal
  }
}

/**
 * Read-only enumeration of every (peerUserId, peerDeviceId, sessionId)
 * tuple known locally for the given self device. Used by the e2ee-session
 * router to diagnose unknown-sessionId ciphertexts and to log multi-device
 * mismatches without touching crypto state.
 */
export async function listKnownSessionIds(
  myUserId: string,
  myDeviceId: string,
): Promise<Array<{ peerUserId: string; peerDeviceId: string; sessionId: string; lastUsedAt: number }>> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    const all = await new Promise<StoredSession[]>((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as StoredSession[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${myUserId}::${myDeviceId}::`;
    const out: Array<{ peerUserId: string; peerDeviceId: string; sessionId: string; lastUsedAt: number }> = [];
    for (const s of all) {
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

/**
 * Drop ALL device-pair sessions.
 *
 * SECURITY: this is destructive — old sessions may still be needed to read
 * in-flight messages currently sitting in `pendingMessageQueue`. Reserved
 * STRICTLY for explicit user-initiated flows:
 *   - logout
 *   - manual "reset E2EE" from settings
 *   - verified key restore from encrypted backup (`resyncE2EE`)
 *
 * Never call as part of an automatic error-recovery path.
 */
export async function clearAllDeviceSessions(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // non-fatal
  }
}
