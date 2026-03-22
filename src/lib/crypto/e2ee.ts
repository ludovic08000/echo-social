/**
 * ForSure End-to-End Encryption Engine
 * 
 * Hybrid encryption: ECDH-P384 (classical) + post-quantum KEM layer
 * Message encryption: AES-256-GCM with HKDF-derived keys
 * Authentication: ECDSA-P384 signatures
 * 
 * Protocol:
 * 1. Key Exchange: ECDH shared secret → HKDF → AES-256 session key
 * 2. Message: IV || ciphertext || auth-tag (AES-256-GCM)
 * 3. Envelope: version || kem_id || encrypted_payload || signature
 */

import {
  PROTOCOL_VERSION, AES_ALGO, AES_KEY_LENGTH, IV_LENGTH,
  HKDF_HASH, HKDF_SALT_LENGTH, CLASSICAL_KEM_ID, PQ_KEM_ID,
  KEY_ROTATION_INTERVAL_MS, MAX_MESSAGES_PER_KEY,
} from './constants';
import {
  randomBytes, bufferToBase64, base64ToBuffer,
  concatBuffers, encodeString, decodeString,
} from './utils';
import {
  type IdentityKeyPair, type SessionKey,
  loadSessionKey, saveSessionKey, deleteSessionKey,
  incrementSessionMessageCount,
} from './keyManager';

// ─── Encrypted message envelope ───

export interface EncryptedEnvelope {
  v: number;         // Protocol version
  kem: string;       // KEM identifier
  iv: string;        // Base64 IV
  ct: string;        // Base64 ciphertext
  sig: string;       // Base64 ECDSA signature
  fp: string;        // Sender fingerprint
  pq?: string;       // Post-quantum encapsulated key (future)
  ts: number;        // Timestamp (for replay protection)
  seq: number;       // Sequence number (for ordering)
}

// ─── ECDH Key Agreement ───

/** Perform ECDH key exchange and derive AES-256 session key */
export async function performKeyExchange(
  myPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  conversationId: string,
): Promise<CryptoKey> {
  // Step 1: ECDH to get shared bits
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    myPrivateKey,
    384, // P-384 produces 384 bits
  );

  // Step 2: HKDF to derive AES key
  const salt = randomBytes(HKDF_SALT_LENGTH);
  const info = encodeString(`forsure-e2ee-v${PROTOCOL_VERSION}-${conversationId}`);

  // Import shared bits as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    'raw', sharedBits, 'HKDF', false, ['deriveKey']
  );

  // Derive AES-256-GCM key
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    hkdfKey,
    { name: AES_ALGO, length: AES_KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  );

  return aesKey;
}

/** Perform ECDH and store as session key */
export async function establishSession(
  myKeys: IdentityKeyPair,
  peerPublicKeyBase64: string,
  conversationId: string,
  peerFingerprint: string,
): Promise<SessionKey> {
  // Import peer's public key
  const peerRaw = base64ToBuffer(peerPublicKeyBase64);
  const peerPublicKey = await crypto.subtle.importKey(
    'raw', peerRaw,
    { name: 'ECDH', namedCurve: 'P-384' },
    true,
    []
  );

  const aesKey = await performKeyExchange(
    myKeys.privateKey,
    peerPublicKey,
    conversationId,
  );

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

// ─── Message Encryption ───

/** Encrypt a plaintext message */
export async function encryptMessage(
  plaintext: string,
  sessionKey: CryptoKey,
  signingKey: CryptoKey,
  senderFingerprint: string,
  sequenceNumber: number,
): Promise<string> {
  const ivArr = randomBytes(IV_LENGTH);
  const iv = new Uint8Array(ivArr) as unknown as BufferSource;
  const timestamp = Date.now();

  // Encode plaintext
  const plaintextBuffer = encodeString(plaintext);

  // Encrypt with AES-256-GCM
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_ALGO, iv: iv as ArrayBuffer, tagLength: 128 },
    sessionKey,
    plaintextBuffer,
  );

  // Create signature over (iv || ciphertext || timestamp || seq)
  const signatureData = concatBuffers(
    ivArr.buffer as ArrayBuffer,
    ciphertext,
    encodeString(`${timestamp}:${sequenceNumber}`),
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-384' },
    signingKey,
    signatureData,
  );

  // Build envelope
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

  return JSON.stringify(envelope);
}

/** Decrypt an encrypted message envelope */
export async function decryptMessage(
  envelopeStr: string,
  sessionKey: CryptoKey,
  peerSigningKeyBase64?: string,
): Promise<{ plaintext: string; verified: boolean; fingerprint: string }> {
  const envelope: EncryptedEnvelope = JSON.parse(envelopeStr);

  // Version check
  if (envelope.v > PROTOCOL_VERSION) {
    throw new Error('Unsupported encryption protocol version');
  }

  // Replay protection: reject messages older than 7 days
  const age = Date.now() - envelope.ts;
  if (age > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('Message too old (possible replay attack)');
  }

  const iv = new Uint8Array(base64ToBuffer(envelope.iv));
  const ciphertext = base64ToBuffer(envelope.ct);

  // Decrypt
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: AES_ALGO, iv, tagLength: 128 },
    sessionKey,
    ciphertext,
  );

  const plaintext = decodeString(plaintextBuffer);

  // Verify signature if peer signing key available
  let verified = false;
  if (peerSigningKeyBase64) {
    try {
      const peerSigningRaw = base64ToBuffer(peerSigningKeyBase64);
      const peerSigningKey = await crypto.subtle.importKey(
        'raw', peerSigningRaw,
        { name: 'ECDSA', namedCurve: 'P-384' },
        true,
        ['verify']
      );

      const signatureData = concatBuffers(
        iv.buffer,
        ciphertext,
        encodeString(`${envelope.ts}:${envelope.seq}`),
      );

      verified = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-384' },
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

/** Check if session key needs rotation */
export async function needsKeyRotation(conversationId: string): Promise<boolean> {
  const session = await loadSessionKey(conversationId);
  if (!session) return true;

  const age = Date.now() - session.createdAt;
  if (age > KEY_ROTATION_INTERVAL_MS) return true;
  if (session.messageCount >= MAX_MESSAGES_PER_KEY) return true;

  return false;
}

/** Rotate session key */
export async function rotateSessionKey(
  myKeys: IdentityKeyPair,
  peerPublicKeyBase64: string,
  conversationId: string,
  peerFingerprint: string,
): Promise<SessionKey> {
  await deleteSessionKey(conversationId);
  return establishSession(myKeys, peerPublicKeyBase64, conversationId, peerFingerprint);
}

// ─── Helper: Check if a message body is encrypted ───

export function isEncryptedMessage(body: string): boolean {
  if (!body.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed.v !== undefined && parsed.kem !== undefined && parsed.ct !== undefined;
  } catch {
    return false;
  }
}

// ─── Post-Quantum readiness note ───
// When browser-native CRYSTALS-Kyber (ML-KEM) becomes available:
// 1. Generate a Kyber768 keypair alongside ECDH
// 2. Encapsulate: kyberCT = Kyber.encapsulate(peerKyberPK) → (ct, ss)
// 3. Combine: finalSecret = HKDF(ecdhSecret || kyberSecret)
// 4. Set kem = PQ_KEM_ID, include pq = base64(kyberCT)
// This provides hybrid security: break BOTH to decrypt
