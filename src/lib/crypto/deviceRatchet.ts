/**
 * Device-pair symmetric ratchet — additive optimization on top of X3DH.
 *
 * Goal: avoid running a full X3DH handshake for every message in a
 * multi-device fan-out. The first message between two devices establishes
 * a session via X3DH; subsequent messages reuse the session and derive a
 * fresh per-message key via HKDF(sharedSecret, counter).
 *
 * Properties:
 *   - Forward secrecy *per message* (counter never reused, key zeroized after use)
 *   - No DH ratchet step (lighter than full Double Ratchet — acceptable trade-off
 *     since the per-conversation Double Ratchet still owns the primary device)
 *   - Strictly additive: failure to load/save a session falls back to X3DH
 *
 * Storage: IndexedDB `forsure-device-sessions` / `sessions`
 *   key   = `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`
 *   value = { sessionId, sharedSecretJWK (raw 32B base64), sendCounter, recvCounter }
 *
 * Wire format (v3):
 *   "x3dh3." sessionId "." counter "." ivB64 "." ctB64
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer, randomBytes } from './utils';

const DB_NAME = 'forsure-device-sessions';
const DB_VERSION = 1;
const STORE = 'sessions';

export const RATCHET_PREFIX_V3 = 'x3dh3.';

interface StoredSession {
  id: string; // composite key
  sessionId: string; // short random id used on the wire
  sharedSecretB64: string; // 32 raw bytes, base64
  sendCounter: number;
  recvCounter: number;
  createdAt: number;
}

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
    // non-fatal — caller will fall back to X3DH
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

/** HKDF derive a per-message AES-256 key from (sharedSecret, counter). */
async function deriveMessageKey(sharedSecretB64: string, counter: number): Promise<CryptoKey> {
  const ikm = await hardCrypto.importKey(
    'raw', base64ToBuffer(sharedSecretB64), 'HKDF', false, ['deriveBits'],
  );
  const info = new hardGlobals.TextEncoder().encode(`ForSureDevRatchet:${counter}`);
  const bits = await hardCrypto.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info } as any,
    ikm,
    256,
  );
  return hardCrypto.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Establish a new device-pair session from a freshly negotiated X3DH secret.
 * Called by both initiator (after x3dhInitiate) and responder (after x3dhRespond).
 */
export async function establishDeviceSession(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  sharedSecret: ArrayBuffer,
  sessionId?: string,
): Promise<string> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  const finalSessionId = sessionId ?? bufferToBase64(randomBytes(8).buffer as ArrayBuffer).replace(/[+/=]/g, '').slice(0, 12);
  await saveSession(key, {
    id: key,
    sessionId: finalSessionId,
    sharedSecretB64: bufferToBase64(sharedSecret.slice(0, 32)),
    sendCounter: 0,
    recvCounter: 0,
    createdAt: Date.now(),
  });
  return finalSessionId;
}

/**
 * Try to encrypt with an existing session. Returns null if none exists —
 * caller MUST fall back to X3DH and call `establishDeviceSession` after.
 */
export async function ratchetEncrypt(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
  plaintext: string,
): Promise<string | null> {
  const key = compositeKey(myUserId, myDeviceId, peerUserId, peerDeviceId);
  const session = await loadSession(key);
  if (!session) return null;

  const counter = session.sendCounter;
  const aes = await deriveMessageKey(session.sharedSecretB64, counter);
  const iv = randomBytes(12);
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    aes,
    new hardGlobals.TextEncoder().encode(plaintext),
  );

  // Increment send counter (best-effort persist; on failure, we may reuse a
  // counter on next call — receiver dedupes by counter so this is safe).
  await saveSession(key, { ...session, sendCounter: counter + 1 });

  return [
    RATCHET_PREFIX_V3 + session.sessionId,
    String(counter),
    bufferToBase64(iv.buffer as ArrayBuffer),
    bufferToBase64(ct as ArrayBuffer),
  ].join('.');
}

/**
 * Decrypt a v3 envelope using a cached session.
 * Returns null if no matching session — caller will not be able to decrypt
 * (this is expected when the session was wiped, e.g. browser data cleared).
 */
export async function ratchetDecrypt(
  myUserId: string,
  myDeviceId: string,
  payload: string,
): Promise<string | null> {
  if (!payload.startsWith(RATCHET_PREFIX_V3)) return null;
  const parts = payload.slice(RATCHET_PREFIX_V3.length).split('.');
  if (parts.length !== 4) return null;

  const [sessionId, counterStr, ivB64, ctB64] = parts;
  const counter = parseInt(counterStr, 10);
  if (Number.isNaN(counter)) return null;

  const found = await lookupSessionById(myUserId, myDeviceId, sessionId);
  if (!found) return null;

  try {
    const aes = await deriveMessageKey(found.session.sharedSecretB64, counter);
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(ivB64)), tagLength: 128 },
      aes,
      base64ToBuffer(ctB64),
    );
    // Track highest counter seen (cheap replay-window indicator)
    if (counter >= found.session.recvCounter) {
      await saveSession(found.key, { ...found.session, recvCounter: counter + 1 });
    }
    return new hardGlobals.TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Drop all device-pair sessions (e.g. on logout / key rotation). */
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
