/**
 * Aegis device-pair Double Ratchet — bidirectional with DH-ratchet.
 *
 * Provides:
 *   - Forward Secrecy (FS): each message key is derived once via KDF chain
 *     and immediately discarded (no key reuse).
 *   - Post-Compromise Security (PCS): a fresh X25519 ratchet key is generated
 *     at each DH-ratchet turn. Messages inside one sending chain only advance
 *     its KDF, avoiding needless DH/key allocations per message.
 *   - Out-of-order delivery: skipped message keys are cached (bounded) so
 *     reordered messages still decrypt.
 *
 * Aegis device-capsule wire format:
 *   "aegis1.ratchet." sessionId "." dhPubB64 "." Ns "." PN "." ivB64 "." ctB64
 *     - dhPubB64 : sender's current ratchet public key (X25519)
 *     - Ns       : message number in current sending chain
 *     - PN       : length of previous sending chain (lets receiver skip keys)
 *
 * No earlier device-copy prefix is accepted.
 *
 * Storage follows Sesame's DeviceRecord model:
 *   active   = `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`
 *   inactive = `${activeKey}::inactive::${sessionId}`
 * Delayed messages may decrypt with an inactive session; a successful
 * decryption promotes it atomically back to active.
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer, randomBytes, importKeyFromJWK, importOkpPublicKeyFromBase64 } from './utils';
import {
  AEGIS_RATCHET_PREFIX,
  createAegisSessionId,
  isAegisSessionId,
  parseAegisRatchetPayload,
  type ParsedAegisRatchetPayload,
} from './aegisDeviceWire';
import { logCryptoError } from './errorLogger';
import { exportPublicKeyRaw } from './keyManager';
import { runTxOn, reqToPromise } from './indexedDbTx';
import {
  RATCHET_MAX_SKIP,
  RATCHET_MAX_SKIPPED_CACHE,
  RATCHET_SKIPPED_TTL_MS,
} from './constants';
import { runDeviceSessionJob } from './deviceSessionQueue';
import { wrapSkippedKey, unwrapSkippedKey } from './skippedKeyVault';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

const STORE = 'sessions';

export { AEGIS_RATCHET_PREFIX } from './aegisDeviceWire';

const AEGIS_DEVICE_AAD = 'FORSURE-AEGIS-DEVICE-v1|';
const AEGIS_HEADER_AAD = 'FORSURE-AEGIS-HEADER-v1|';
const X25519_ALGORITHM: Algorithm = { name: 'X25519' };

// A bounded skipped-key window tolerates reordered delivery after mobile wake.
const MAX_SKIP = RATCHET_MAX_SKIP;            // max skipped message keys per chain
const MAX_SKIPPED_TOTAL = RATCHET_MAX_SKIPPED_CACHE;  // hard cap across all stored skipped keys
const MAX_INACTIVE_SESSIONS = 5;
const INACTIVE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface SkippedKey {
  /** dhPub (peer ratchet pub) of the chain the key belongs to, base64 */
  dhPubB64: string;
  /** message number in that chain */
  n: number;
  /**
   * Clé de message scellée localement par la SWK (AES-GCM non exportable).
   * Invariant corrigé : plus aucune clé sautée en clair dans IndexedDB.
   */
  wrapB64: string;
  wrapIvB64: string;
  /** creation time used to enforce the bounded out-of-order window */
  createdAt?: number;
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
  lastUsedAt?: number;
  inactiveAt?: number;

  /**
   * SPK id used only to describe the original X3DH bootstrap. Signed-prekey
   * rotation never invalidates an established Double Ratchet session.
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

function inactiveSessionKey(activeKey: string, sessionId: string): string {
  return `${activeKey}::inactive::${sessionId}`;
}

function activeKeyFromStorageKey(key: string): string | null {
  const parts = key.split('::');
  return parts.length >= 4 ? parts.slice(0, 4).join('::') : null;
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
  return new hardGlobals.TextEncoder().encode(`${AEGIS_DEVICE_AAD}${sessionId}|${a}|${b}`);
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
    `${AEGIS_HEADER_AAD}${header.dh}|${header.pn}|${header.n}`,
  );
  const out = new Uint8Array(identityAd.byteLength + headerAd.byteLength);
  out.set(identityAd, 0);
  out.set(headerAd, identityAd.byteLength);
  return out;
}

function parseCompositeKey(key: string): { myUserId: string; myDeviceId: string; peerUserId: string; peerDeviceId: string } | null {
  const parts = key.split('::');
  if (parts.length < 4) return null;
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

async function installActiveSession(key: string, session: StoredSession): Promise<void> {
  await runTxOn('device-sessions', [STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(STORE);
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const now = Date.now();
        const all = (request.result as StoredSession[]) ?? [];
        const active = all.find((candidate) => candidate.id === key);
        if (active && active.sessionId !== session.sessionId) {
          store.put({
            ...active,
            id: inactiveSessionKey(key, active.sessionId),
            inactiveAt: now,
            lastUsedAt: active.lastUsedAt ?? now,
          });
          traceE2EE({
            direction: 'session',
            stage: 'SESSION_MOVED_INACTIVE',
            sessionId: active.sessionId,
            deviceId: key.split('::')[1],
            peerDeviceId: key.split('::')[3],
          });
        }

        store.delete(inactiveSessionKey(key, session.sessionId));
        store.put({
          ...session,
          id: key,
          inactiveAt: undefined,
          lastUsedAt: now,
        });
        traceE2EE({
          direction: 'session',
          stage: active && active.sessionId !== session.sessionId
            ? 'SESSION_REPLACED_ACTIVE'
            : 'SESSION_ACTIVE',
          sessionId: session.sessionId,
          deviceId: key.split('::')[1],
          peerDeviceId: key.split('::')[3],
        });

        const inactive = all
          .filter((candidate) => candidate.id.startsWith(`${key}::inactive::`))
          .filter((candidate) => candidate.sessionId !== session.sessionId)
          .sort((a, b) => (b.inactiveAt ?? b.lastUsedAt ?? b.createdAt) - (a.inactiveAt ?? a.lastUsedAt ?? a.createdAt));
        inactive.forEach((candidate, index) => {
          const age = now - (candidate.inactiveAt ?? candidate.lastUsedAt ?? candidate.createdAt);
          if (index >= MAX_INACTIVE_SESSIONS || age > INACTIVE_SESSION_TTL_MS) {
            store.delete(candidate.id);
          }
        });
        resolve();
      };
    }),
  );
}

async function persistSuccessfulDecrypt(
  activeKey: string,
  storageKey: string,
  session: StoredSession,
): Promise<void> {
  if (storageKey === activeKey) {
    await saveSession(activeKey, { ...session, lastUsedAt: Date.now() });
    return;
  }
  traceE2EE({
    direction: 'session',
    stage: 'INACTIVE_SESSION_PROMOTED',
    sessionId: session.sessionId,
    deviceId: activeKey.split('::')[1],
    peerDeviceId: activeKey.split('::')[3],
  });
  await installActiveSession(activeKey, { ...session, lastUsedAt: Date.now() });
}

async function lookupSessionById(
  myUserId: string,
  myDeviceId: string,
  sessionId: string,
): Promise<{ key: string; activeKey: string; session: StoredSession } | null> {
  try {
    const all = await runTxOn('device-sessions', [STORE], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(STORE).getAll() as IDBRequest<StoredSession[]>),
    );
    const prefix = `${myUserId}::${myDeviceId}::`;
    for (const s of all ?? []) {
      if (s.sessionId === sessionId && s.id.startsWith(prefix)) {
        const activeKey = activeKeyFromStorageKey(s.id);
        if (activeKey) return { key: s.id, activeKey, session: s };
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
    const aes = await importMessageKey(await unwrapSkippedKey(entry));
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

function pruneExpiredSkippedKeys(
  session: StoredSession,
  now = Date.now(),
): StoredSession {
  const skipped = session.skipped.filter((entry) =>
    // Les anciennes entrées en clair (sans scellement SWK) sont écartées.
    typeof entry.wrapB64 === 'string' &&
    typeof entry.wrapIvB64 === 'string' &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt) &&
    now - entry.createdAt >= 0 &&
    now - entry.createdAt <= RATCHET_SKIPPED_TTL_MS,
  );
  return skipped.length === session.skipped.length
    ? session
    : { ...session, skipped };
}

async function skipMessageKeys(session: StoredSession, until: number): Promise<StoredSession> {
  if (session.ckRecvB64 === null) return session;
  if (session.Nr + MAX_SKIP < until) {
    throw new Error('too_many_skipped');
  }
  const pruned = pruneExpiredSkippedKeys(session);
  const s = { ...pruned, skipped: [...pruned.skipped] };
  while (s.Nr < until) {
    const { ck, mk } = await kdfCK(s.ckRecvB64!);
    const sealed = await wrapSkippedKey(mk);
    s.skipped.push({
      dhPubB64: s.dhrPubB64!,
      n: s.Nr,
      wrapB64: sealed.wrapB64,
      wrapIvB64: sealed.wrapIvB64,
      createdAt: Date.now(),
    });
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
  const finalSessionId = sessionId ?? createAegisSessionId();
  if (!isAegisSessionId(finalSessionId)) {
    throw new Error('AEGIS_SESSION_ID_INVALID');
  }
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

  await installActiveSession(key, session);
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
  const aad = buildDevAADWithHeader(
    myUserId,
    myDeviceId,
    peerUserId,
    peerDeviceId,
    session.sessionId,
    header,
  );
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> },
    aes,
    new hardGlobals.TextEncoder().encode(plaintext),
  );
  await saveSession(key, { ...session, ckSendB64: ck, Ns: Ns + 1 });

  return [
    AEGIS_RATCHET_PREFIX + session.sessionId,
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
  const parsed = parseAegisRatchetPayload(payload);
  if (!parsed) return null;
  const found = await lookupSessionById(myUserId, myDeviceId, parsed.sessionId);
  if (!found) return null;
  return runDeviceSessionJob('ratchet', found.activeKey, () =>
    decryptAegis(myUserId, myDeviceId, parsed),
  );
}

async function decryptAegis(
  myUserId: string,
  myDeviceId: string,
  parsed: ParsedAegisRatchetPayload,
): Promise<string | null> {
  const found = await lookupSessionById(myUserId, myDeviceId, parsed.sessionId);
  if (!found) return null;
  const peer = parseCompositeKey(found.key);
  if (!peer) return null;
  const aad = buildDevAADWithHeader(
    peer.myUserId,
    peer.myDeviceId,
    peer.peerUserId,
    peer.peerDeviceId,
    parsed.sessionId,
    { dh: parsed.dhPubB64, n: parsed.n, pn: parsed.pn },
  );
  return decryptAegisWithStored(found.activeKey, found.key, found.session, parsed, aad, peer);
}

async function ratchetDecryptWithSessionUnlocked(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  payload: string,
): Promise<string | null> {
  const parsed = parseAegisRatchetPayload(payload);
  if (!parsed) return null;
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  const found = await lookupSessionById(myUserId, myDeviceId, parsed.sessionId);
  if (!found || found.activeKey !== key) return null;
  const aad = buildDevAADWithHeader(
    myUserId,
    myDeviceId,
    peerUserId,
    peerDeviceId,
    parsed.sessionId,
    { dh: parsed.dhPubB64, n: parsed.n, pn: parsed.pn },
  );
  return decryptAegisWithStored(key, found.key, found.session, parsed, aad, {
    peerUserId,
    peerDeviceId,
  });
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

async function decryptAegisWithStored(
  activeKey: string,
  storageKey: string,
  initialSession: StoredSession,
  parsed: ParsedAegisRatchetPayload,
  aad: Uint8Array,
  logContext: DecryptLogContext = {},
): Promise<string | null> {
  const { sessionId, dhPubB64, n: Ns, pn: PN, iv, ciphertext: ct } = parsed;

  let session = pruneExpiredSkippedKeys(initialSession);
  const skipped = await trySkippedKeys(session, dhPubB64, Ns, iv, ct, aad);
  if (skipped) {
    await persistSuccessfulDecrypt(activeKey, storageKey, skipped.updated);
    return skipped.pt;
  }

  // Invariant corrigé : rejeu explicite. Sur la chaîne de réception courante,
  // un n déjà consommé (n < Nr) sans clé sautée correspondante ne peut être
  // qu'un message rejoué — on refuse au lieu de reconstruire une clé.
  if (session.dhrPubB64 === dhPubB64 && Ns < session.Nr) {
    void logCryptoError({
      severity: 'warning',
      context: 'decrypt',
      errorCode: 'AEGIS_DEVICE_REPLAY_REJECTED',
      errorMessage: `replayed message n=${Ns} < Nr=${session.Nr}`,
      myDeviceId: activeKey.split('::')[1] ?? 'unknown',
      peerUserId: logContext.peerUserId,
      peerDeviceId: logContext.peerDeviceId,
    });
    return null;
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
    await persistSuccessfulDecrypt(activeKey, storageKey, session);
    return new hardGlobals.TextDecoder().decode(pt);
  } catch (err) {
    void logCryptoError({
      severity: 'error',
      context: 'decrypt',
      errorCode: 'AEGIS_DEVICE_DECRYPT_FAILED',
      errorMessage: err instanceof Error ? err.message : String(err),
      myDeviceId: activeKey.split('::')[1] ?? 'unknown',
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
    const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
    await runTxOn('device-sessions', [STORE], 'readwrite', (tx) =>
      new Promise<void>((resolve, reject) => {
        const store = tx.objectStore(STORE);
        const request = store.getAllKeys();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          for (const storedKey of request.result) {
            const value = String(storedKey);
            if (value === key || value.startsWith(`${key}::inactive::`)) {
              store.delete(storedKey);
            }
          }
          resolve();
        };
      }),
    );
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
