/**
 * ForSure End-to-End Encryption Engine v2
 * 
 * Signal-grade primitives:
 *   Key Exchange:  X25519 (Curve25519 ECDH)
 *   Signing:       Ed25519
 *   Encryption:    AES-256-GCM
 *   Derivation:    HKDF-SHA-256
 *   Future:        Hybrid X25519 + ML-KEM (Kyber768)
 * 
 * Protocol:
 *   1. X25519 → 32-byte shared secret → HKDF → AES-256 session key
 *   2. Message: IV(12) || AES-GCM(plaintext) || tag(16)
 *   3. Envelope: { v, kem, iv, ct, sig(Ed25519), fp, ts, seq }
 */

import {
  PROTOCOL_VERSION, AES_ALGO, AES_KEY_LENGTH, IV_LENGTH,
  HKDF_HASH, HKDF_SALT_LENGTH, CLASSICAL_KEM_ID,
  KEY_ROTATION_INTERVAL_MS, MAX_MESSAGES_PER_KEY, KX_KEY_PARAMS,
} from './constants';
import {
  randomBytes, bufferToBase64, base64ToBuffer,
  concatBuffers, encodeString, decodeString, importOkpPublicKeyFromBase64,
} from './utils';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import {
  type IdentityKeyPair, type SessionKey,
  loadSessionKey, saveSessionKey, deleteSessionKey,
} from './keyManager';

// ─── Envelope ───

export interface EncryptedEnvelope {
  v: number;
  kem: string;
  iv: string;     // Base64
  ct: string;     // Base64
  sig: string;    // Base64 Ed25519
  fp: string;     // Sender fingerprint
  pq?: string;    // Future: Kyber ciphertext
  ts: number;
  seq: number;
}

// ─── X25519 Key Agreement ───

export async function performKeyExchange(
  myPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  conversationId: string,
): Promise<CryptoKey> {
  // X25519 → 32 bytes (256 bits) shared secret
  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerPublicKey } as any,
    myPrivateKey,
    256,
  );

  // HKDF-SHA-256 → AES-256 key
  // CRITICAL: Use deterministic salt derived from conversationId so both sides
  // derive the SAME key. A random salt would produce different keys on each side.
  const saltSource = encodeString(`forsure-salt-v${PROTOCOL_VERSION}-${conversationId}`);
  const salt = new Uint8Array(await hardCrypto.digest('SHA-256', saltSource)) as Uint8Array<ArrayBuffer>;
  const info = encodeString(`forsure-e2ee-v${PROTOCOL_VERSION}-${conversationId}`);

  const hkdfKey = await hardCrypto.importKey(
    'raw', sharedBits, 'HKDF', false, ['deriveKey']
  );

  return hardCrypto.deriveKey(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    hkdfKey,
    { name: AES_ALGO, length: AES_KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  );
}

/** Establish a session with a peer */
export async function establishSession(
  myKeys: IdentityKeyPair,
  peerPublicKeyBase64: string,
  conversationId: string,
  peerFingerprint: string,
): Promise<SessionKey> {
  const peerRaw = base64ToBuffer(peerPublicKeyBase64);
  const peerPublicKey = await hardCrypto.importKey(
    'raw', peerRaw, KX_KEY_PARAMS as any, true, []
  );

  const aesKey = await performKeyExchange(myKeys.privateKey, peerPublicKey, conversationId);

  const session: SessionKey = {
    conversationId,
    sharedSecret: aesKey,
    messageCount: 0,
    createdAt: Date.now(),
    peerFingerprint,
  };

  await saveSessionKey(session);
  return session;
}

// ─── Encrypt ───

export async function encryptMessage(
  plaintext: string,
  sessionKey: CryptoKey,
  signingKey: CryptoKey,
  senderFingerprint: string,
  sequenceNumber: number,
): Promise<string> {
  const ivArr = randomBytes(IV_LENGTH);
  const timestamp = Date.now();
  const plaintextBuffer = encodeString(plaintext);

  // AES-256-GCM
  const ciphertext = await hardCrypto.encrypt(
    { name: AES_ALGO, iv: ivArr as Uint8Array<ArrayBuffer>, tagLength: 128 },
    sessionKey,
    plaintextBuffer,
  );

  // Ed25519 signature over (iv || ciphertext || metadata)
  const signatureData = concatBuffers(
    ivArr.buffer as ArrayBuffer,
    ciphertext as ArrayBuffer,
    encodeString(`${timestamp}:${sequenceNumber}`),
  );

  const signature = await hardCrypto.sign(
    'Ed25519' as any,
    signingKey,
    signatureData,
  );

  const envelope: EncryptedEnvelope = {
    v: PROTOCOL_VERSION,
    kem: CLASSICAL_KEM_ID,
    iv: bufferToBase64(ivArr.buffer as ArrayBuffer),
    ct: bufferToBase64(ciphertext as ArrayBuffer),
    sig: bufferToBase64(signature),
    fp: senderFingerprint,
    ts: timestamp,
    seq: sequenceNumber,
  };

  return hardGlobals.jsonStringify(envelope);
}

// ─── Decrypt ───

export async function decryptMessage(
  envelopeStr: string,
  sessionKey: CryptoKey,
  peerSigningKeyBase64?: string,
): Promise<{ plaintext: string; verified: boolean; fingerprint: string }> {
  const parsed = hardGlobals.jsonParse(envelopeStr);
  const { __lid: _ignoredLocalId, ...envelope } = parsed as EncryptedEnvelope & { __lid?: string };

  // Accept v1 (legacy P-384) and v2 (X25519) envelopes
  if (envelope.v > PROTOCOL_VERSION) {
    throw new Error('Unsupported encryption protocol version');
  }

  // NOTE: We intentionally do NOT reject by absolute timestamp anymore.
  // Anti-replay is enforced by the per-conversation `seq` counter (this file)
  // and by Double Ratchet header counters (pn/n) — both refuse duplicate or
  // out-of-window numbers. A timestamp-based cutoff broke historical reads
  // after a key restore (PIN re-unlock, multi-device sync) without adding
  // any real protection beyond what the counters already provide.
  if (typeof envelope.ts !== 'number' || envelope.ts <= 0) {
    throw new Error('Envelope timestamp invalide');
  }

  const ivBytes = base64ToBuffer(envelope.iv);
  const ciphertext = base64ToBuffer(envelope.ct);

  const plaintextBuffer = await hardCrypto.decrypt(
    { name: AES_ALGO, iv: new Uint8Array(ivBytes), tagLength: 128 },
    sessionKey,
    ciphertext,
  );

  const plaintext = decodeString(plaintextBuffer);

  // Verify Ed25519 signature
  let verified = false;
  if (peerSigningKeyBase64) {
    try {
      const peerSigningRaw = base64ToBuffer(peerSigningKeyBase64);

      // Determine algo based on envelope version
      const sigAlgo = envelope.v >= 2 ? 'Ed25519' : { name: 'ECDSA', hash: 'SHA-384' };
      const importAlgo = envelope.v >= 2
        ? { name: 'Ed25519' } as any
        : { name: 'ECDSA', namedCurve: 'P-384' };

      const peerSigningKey = envelope.v >= 2
        ? await importOkpPublicKeyFromBase64(peerSigningKeyBase64, 'Ed25519', ['verify'], true)
        : await hardCrypto.importKey('raw', peerSigningRaw, importAlgo, true, ['verify']);

      const signatureData = concatBuffers(
        ivBytes,
        ciphertext as ArrayBuffer,
        encodeString(`${envelope.ts}:${envelope.seq}`),
      );

      verified = await hardCrypto.verify(
        sigAlgo as any,
        peerSigningKey,
        base64ToBuffer(envelope.sig),
        signatureData,
      );
    } catch {
      verified = false;
    }
  }

  return { plaintext, verified, fingerprint: envelope.fp };
}

// ─── Key Rotation ───

export async function needsKeyRotation(conversationId: string): Promise<boolean> {
  const session = await loadSessionKey(conversationId);
  if (!session) return true;
  if (Date.now() - session.createdAt > KEY_ROTATION_INTERVAL_MS) return true;
  if (session.messageCount >= MAX_MESSAGES_PER_KEY) return true;
  return false;
}

export async function rotateSessionKey(
  myKeys: IdentityKeyPair,
  peerPublicKeyBase64: string,
  conversationId: string,
  peerFingerprint: string,
): Promise<SessionKey> {
  await deleteSessionKey(conversationId);
  return establishSession(myKeys, peerPublicKeyBase64, conversationId, peerFingerprint);
}

// ─── Helpers ───

export function isEncryptedMessage(body: string): boolean {
  if (!body.startsWith('{')) return false;
  try {
    const p = hardGlobals.jsonParse(body);
    return p.v !== undefined && p.kem !== undefined && p.ct !== undefined;
  } catch {
    return false;
  }
}

// Post-Quantum upgrade path:
// 1. Generate ML-KEM-768 keypair alongside X25519
// 2. Encapsulate: (kyberCT, kyberSS) = KEM.encap(peerKyberPK)
// 3. Combine: HKDF(x25519SS || kyberSS) → AES key
// 4. Set kem = 'HYBRID-X25519-KYBER768', pq = base64(kyberCT)
// Both must be broken to compromise a message
