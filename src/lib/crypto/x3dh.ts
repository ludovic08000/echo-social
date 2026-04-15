/**
 * X3DH — Extended Triple Diffie-Hellman Key Agreement (Signal Protocol)
 * 
 * Implements the full X3DH handshake as specified by Signal:
 * https://signal.org/docs/specifications/x3dh/
 * 
 * Participants:
 *   Alice (initiator) has: IKa (identity key)
 *   Bob (responder) has:   IKb (identity key), SPKb (signed prekey), OPKb (one-time prekey)
 * 
 * X3DH computes:
 *   DH1 = DH(IKa, SPKb)     — Alice's identity ↔ Bob's signed prekey
 *   DH2 = DH(EKa, IKb)      — Alice's ephemeral ↔ Bob's identity
 *   DH3 = DH(EKa, SPKb)     — Alice's ephemeral ↔ Bob's signed prekey
 *   DH4 = DH(EKa, OPKb)     — Alice's ephemeral ↔ Bob's one-time prekey (optional)
 * 
 *   SK = KDF(DH1 || DH2 || DH3 [|| DH4])
 * 
 * PQXDH extension (future-ready):
 *   When ML-KEM-768 is available in browsers:
 *   (kemCT, kemSS) = KEM.Encapsulate(peerKyberPK)
 *   SK = KDF(DH1 || DH2 || DH3 [|| DH4] || kemSS)
 *   Both classical and PQ must be broken to compromise SK.
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer, concatBuffers, encodeString } from './utils';
import {
  KX_KEY_PARAMS, SIG_KEY_PARAMS, HKDF_HASH,
  AES_ALGO, AES_KEY_LENGTH, PROTOCOL_VERSION,
} from './constants';
import { supabase } from '@/integrations/supabase/client';
import type { IdentityKeyPair } from './keyManager';

// ─── Types ───

export interface X3DHPrekeyBundle {
  /** Bob's identity public key (X25519, base64) */
  identityKey: string;
  /** Bob's signed prekey public (X25519, base64) */
  signedPrekey: string;
  /** Ed25519 signature over the signed prekey */
  signedPrekeySignature: string;
  /** Bob's signed prekey ID */
  signedPrekeyId: number;
  /** Bob's signing public key (Ed25519, base64) for sig verification */
  signingKey: string;
  /** Bob's one-time prekey (X25519, base64) — optional */
  oneTimePrekey?: string;
  /** One-time prekey ID — optional */
  oneTimePrekeyId?: number;
}

export interface X3DHResult {
  /** Shared secret (32 bytes) to seed Double Ratchet */
  sharedSecret: ArrayBuffer;
  /** Ephemeral public key (base64) — sent to Bob in initial message */
  ephemeralKey: string;
  /** Which one-time prekey was consumed (if any) */
  usedOTPKId?: number;
  /** Signed prekey ID used */
  usedSPKId: number;
  /** KEM ciphertext for PQXDH (future) */
  kemCiphertext?: string;
}

export interface X3DHInitialMessage {
  /** Alice's identity key (base64) */
  ik: string;
  /** Alice's ephemeral key (base64) */
  ek: string;
  /** Bob's signed prekey ID used */
  spkId: number;
  /** Bob's one-time prekey ID used (if any) */
  opkId?: number;
  /** KEM ciphertext (PQXDH future) */
  kemCt?: string;
}

// ─── X3DH Info string (domain separation) ───

const X3DH_INFO = 'ForSure-X3DH-v1';
const X3DH_SALT_BYTES = 32; // All zeros as per Signal spec

// ─── Signed Prekey Management ───

const SPK_ROTATION_DAYS = 7;
const SPK_DB_NAME = 'forsure-spk';
const SPK_DB_VERSION = 1;
const SPK_STORE = 'signed-prekeys';

function openSPKDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = hardGlobals.idbOpen(SPK_DB_NAME, SPK_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SPK_STORE)) {
        db.createObjectStore(SPK_STORE, { keyPath: 'id' });
      }
    };
  });
}

interface StoredSPK {
  id: string; // `${userId}:${spkId}`
  spkId: number;
  privateKeyJWK: JsonWebKey;
  publicKeyBase64: string;
  createdAt: number;
}

async function saveSPKPrivate(userId: string, spkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  const db = await openSPKDB();
  const tx = db.transaction(SPK_STORE, 'readwrite');
  tx.objectStore(SPK_STORE).put({
    id: `${userId}:${spkId}`,
    spkId,
    privateKeyJWK: jwk,
    publicKeyBase64: publicBase64,
    createdAt: Date.now(),
  } as StoredSPK);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadSPKPrivate(userId: string, spkId: number): Promise<CryptoKey | null> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const req = tx.objectStore(SPK_STORE).get(`${userId}:${spkId}`);
    const result = await new Promise<StoredSPK | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    return hardCrypto.importKey(
      'jwk', result.privateKeyJWK,
      KX_KEY_PARAMS as any,
      false,
      ['deriveBits'],
    );
  } catch {
    return null;
  }
}

/**
 * Load a stored SPK record (both private key + public base64).
 * Returns null if not found.
 */
async function loadSPKRecord(userId: string, spkId: number): Promise<StoredSPK | null> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const req = tx.objectStore(SPK_STORE).get(`${userId}:${spkId}`);
    const result = await new Promise<StoredSPK | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return result ?? null;
  } catch {
    return null;
  }
}

async function getNextSPKId(userId: string): Promise<number> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const allKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = tx.objectStore(SPK_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${userId}:`;
    let maxId = 0;
    for (const key of allKeys) {
      const k = String(key);
      if (k.startsWith(prefix)) {
        const id = parseInt(k.slice(prefix.length), 10);
        if (id > maxId) maxId = id;
      }
    }
    return maxId + 1;
  } catch {
    return 1;
  }
}

/**
 * Generate a new signed prekey and upload to server.
 * The SPK is an X25519 key signed by the user's Ed25519 identity key.
 */
export async function generateAndUploadSignedPrekey(
  userId: string,
  signingPrivateKey: CryptoKey,
): Promise<{ spkId: number; publicKey: string; signature: string }> {
  const spkId = await getNextSPKId(userId);

  // Generate X25519 key pair for SPK
  const spkPair = await hardCrypto.generateKey(
    KX_KEY_PARAMS as any, true, ['deriveBits'],
  ) as CryptoKeyPair;

  const publicRaw = await hardCrypto.exportKey('raw', spkPair.publicKey);
  const publicBase64 = bufferToBase64(publicRaw);

  // Sign the SPK public key with Ed25519 identity key
  const signature = await hardCrypto.sign(
    'Ed25519' as any,
    signingPrivateKey,
    publicRaw,
  );
  const signatureBase64 = bufferToBase64(signature);

  // Store private half locally
  await saveSPKPrivate(userId, spkId, spkPair.privateKey, publicBase64);

  // Upload to server
  const { error } = await supabase
    .from('user_signed_prekeys')
    .upsert({
      user_id: userId,
      spk_id: spkId,
      public_key: publicBase64,
      signature: signatureBase64,
      is_active: true,
    }, { onConflict: 'user_id,spk_id' });

  if (error) {
    console.error('[X3DH] SPK upload failed:', error);
    throw new Error('Failed to upload signed prekey');
  }

  // Deactivate previous SPKs on server but keep local private keys
  // (old SPKs may still be referenced by in-flight X3DH messages)
  await supabase
    .from('user_signed_prekeys')
    .update({ is_active: false })
    .eq('user_id', userId)
    .neq('spk_id', spkId);

  console.log(`[X3DH] ✅ Signed prekey #${spkId} generated & uploaded`);
  return { spkId, publicKey: publicBase64, signature: signatureBase64 };
}

/**
 * Check if signed prekey needs rotation (every 7 days) and regenerate if so.
 */
export async function refreshSignedPrekeyIfNeeded(
  userId: string,
  signingPrivateKey: CryptoKey,
): Promise<void> {
  try {
    const { data } = await supabase
      .from('user_signed_prekeys')
      .select('created_at, public_key, signature, spk_id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      console.info('[X3DH] No active SPK found — generating first one');
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
      return;
    }

    // Verify that the existing SPK signature matches the CURRENT signing key.
    // If identity keys were regenerated, the old SPK signature won't verify
    // against the new signing key → must regenerate SPK.
    let signatureValid = false;
    try {
      const spkRaw = base64ToBuffer(data.public_key);
      const sigRaw = base64ToBuffer(data.signature);

      const { data: pubKeyData } = await supabase
        .from('user_public_keys')
        .select('signing_key')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();

      if (pubKeyData) {
        const signingPubKey = await hardCrypto.importKey(
          'raw', base64ToBuffer(pubKeyData.signing_key),
          { name: 'Ed25519' } as any, true, ['verify'],
        );
        signatureValid = await hardCrypto.verify(
          'Ed25519' as any, signingPubKey, sigRaw, spkRaw,
        );
      }

      if (!signatureValid) {
        console.warn('[X3DH] ⚠️ SPK signature verification FAILED against current signing key — SPK out of sync');
      }
    } catch (verifyErr) {
      console.warn('[X3DH] ⚠️ SPK signature verification error:', verifyErr);
      signatureValid = false;
    }

    if (!signatureValid) {
      console.info('[X3DH] Active signed prekey out of sync with current signing key — regenerating');
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
      return;
    }

    // Verify local private half exists for this SPK
    const localRecord = await loadSPKRecord(userId, data.spk_id);
    if (!localRecord) {
      console.warn(`[X3DH] ⚠️ SPK #${data.spk_id} active on server but private key MISSING locally — regenerating`);
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
      return;
    }

    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (ageMs > SPK_ROTATION_DAYS * 24 * 60 * 60 * 1000) {
      console.log('[X3DH] SPK expired, rotating...');
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
    }
  } catch (e) {
    console.error('[X3DH] SPK refresh check failed:', e);
  }
}

// ─── X3DH Initiator (Alice) ───

/**
 * Fetch Bob's prekey bundle from the server.
 * Validates bundle coherence before returning.
 */
export async function fetchPrekeyBundle(peerUserId: string): Promise<X3DHPrekeyBundle | null> {
  // 1. Get identity key + signing key
  const { data: pubKeys } = await supabase
    .from('user_public_keys')
    .select('identity_key, signing_key')
    .eq('user_id', peerUserId)
    .eq('is_active', true)
    .maybeSingle();

  if (!pubKeys) {
    console.warn('[X3DH] fetchPrekeyBundle: peer has no public keys:', peerUserId);
    return null;
  }

  // 2. Get active signed prekey
  const { data: spkData } = await supabase
    .rpc('get_signed_prekey', { p_user_id: peerUserId });

  if (!spkData || spkData.length === 0) {
    console.warn('[X3DH] fetchPrekeyBundle: peer has no signed prekey:', peerUserId);
    return null;
  }

  const spk = spkData[0];

  // 3. Verify SPK signature BEFORE consuming any OPK
  // This prevents wasting a one-time prekey on a stale/invalid bundle
  let sigValid = false;
  try {
    const spkRaw = base64ToBuffer(spk.public_key);
    const sigRaw = base64ToBuffer(spk.signature);
    const peerSigningKey = await hardCrypto.importKey(
      'raw', base64ToBuffer(pubKeys.signing_key),
      { name: 'Ed25519' } as any, true, ['verify'],
    );
    sigValid = await hardCrypto.verify('Ed25519' as any, peerSigningKey, sigRaw, spkRaw);
  } catch (verifyErr) {
    console.error('[X3DH] ⚠️ SPK signature verification error in fetchPrekeyBundle:', verifyErr);
  }

  if (!sigValid) {
    console.error(`[X3DH] ⛔ SPK #${spk.spk_id} signature INVALID for peer ${peerUserId} — bundle REJECTED (possible stale SPK or signing key mismatch)`);
    return null;
  }

  // 4. Try to get a one-time prekey (atomically consumed)
  let oneTimePrekey: string | undefined;
  let oneTimePrekeyId: number | undefined;
  try {
    const { data: opkData } = await supabase
      .rpc('consume_prekey', { p_peer_user_id: peerUserId });
    if (opkData && opkData.length > 0) {
      oneTimePrekey = opkData[0].public_key;
      oneTimePrekeyId = opkData[0].prekey_id;
      console.log(`[X3DH] OPK #${oneTimePrekeyId} consumed for peer ${peerUserId}`);
    } else {
      console.info('[X3DH] No OPK available for peer — X3DH will use 3-DH (still secure)');
    }
  } catch (opkErr) {
    console.warn('[X3DH] OPK consumption failed (non-fatal):', opkErr);
    // X3DH still works with 3 DH operations
  }

  return {
    identityKey: pubKeys.identity_key,
    signingKey: pubKeys.signing_key,
    signedPrekey: spk.public_key,
    signedPrekeySignature: spk.signature,
    signedPrekeyId: spk.spk_id,
    oneTimePrekey,
    oneTimePrekeyId,
  };
}

/**
 * Perform X3DH as the initiator (Alice).
 * 
 * Generates an ephemeral key, performs 3 or 4 DH operations,
 * and derives a shared secret for Double Ratchet initialization.
 */
export async function x3dhInitiate(
  myKeys: IdentityKeyPair,
  bundle: X3DHPrekeyBundle,
): Promise<X3DHResult> {
  // 1. Signature already verified in fetchPrekeyBundle, but double-check
  const spkRaw = base64ToBuffer(bundle.signedPrekey);
  const sigRaw = base64ToBuffer(bundle.signedPrekeySignature);
  const peerSigningKey = await hardCrypto.importKey(
    'raw', base64ToBuffer(bundle.signingKey),
    { name: 'Ed25519' } as any, true, ['verify'],
  );

  const sigValid = await hardCrypto.verify(
    'Ed25519' as any, peerSigningKey, sigRaw, spkRaw,
  );

  if (!sigValid) {
    throw new Error('X3DH: Signed prekey signature verification FAILED — possible MITM');
  }

  // 2. Import peer keys
  const peerIK = await importX25519Public(bundle.identityKey);
  const peerSPK = await importX25519Public(bundle.signedPrekey);

  // 3. Generate ephemeral key pair (EKa)
  const ephemeralPair = await hardCrypto.generateKey(
    KX_KEY_PARAMS as any, true, ['deriveBits'],
  ) as CryptoKeyPair;

  const ephPubRaw = await hardCrypto.exportKey('raw', ephemeralPair.publicKey);
  const ephemeralKey = bufferToBase64(ephPubRaw);

  // 4. Compute DH operations
  // DH1 = DH(IKa_priv, SPKb_pub)
  const dh1 = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerSPK } as any,
    myKeys.privateKey,
    256,
  );

  // DH2 = DH(EKa_priv, IKb_pub)
  const dh2 = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerIK } as any,
    ephemeralPair.privateKey,
    256,
  );

  // DH3 = DH(EKa_priv, SPKb_pub)
  const dh3 = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerSPK } as any,
    ephemeralPair.privateKey,
    256,
  );

  // DH4 = DH(EKa_priv, OPKb_pub) — optional
  let dh4: ArrayBuffer | null = null;
  if (bundle.oneTimePrekey) {
    const peerOPK = await importX25519Public(bundle.oneTimePrekey);
    dh4 = await hardCrypto.deriveBits(
      { name: 'X25519', public: peerOPK } as any,
      ephemeralPair.privateKey,
      256,
    );
  }

  // 5. Combine DH outputs: SK = KDF(F || DH1 || DH2 || DH3 [|| DH4])
  // F = 0xFF * 32 bytes (as per Signal X3DH spec for domain separation)
  const filler = new Uint8Array(32).fill(0xFF);
  const dhConcat = dh4
    ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4)
    : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);

  // 6. HKDF to derive final shared secret
  const sharedSecret = await x3dhKDF(dhConcat);

  console.log(`[X3DH] ✅ Initiated with ${dh4 ? '4' : '3'} DH operations (SPK #${bundle.signedPrekeyId}${bundle.oneTimePrekeyId ? `, OPK #${bundle.oneTimePrekeyId}` : ''})`);

  return {
    sharedSecret,
    ephemeralKey,
    usedOTPKId: bundle.oneTimePrekeyId,
    usedSPKId: bundle.signedPrekeyId,
  };
}

// ─── X3DH Responder (Bob) ───

/**
 * Perform X3DH as the responder (Bob).
 * 
 * Bob receives Alice's initial message header and computes the same shared secret.
 * Returns the shared secret AND Bob's SPK key pair for Double Ratchet init.
 */
export async function x3dhRespond(
  myKeys: IdentityKeyPair,
  myUserId: string,
  initialMessage: X3DHInitialMessage,
): Promise<{ sharedSecret: ArrayBuffer; spkKeyPair: CryptoKeyPair }> {
  // 1. Import Alice's keys
  const aliceIK = await importX25519Public(initialMessage.ik);
  const aliceEK = await importX25519Public(initialMessage.ek);

  // 2. Load our signed prekey record (private + public)
  const spkRecord = await loadSPKRecord(myUserId, initialMessage.spkId);
  if (!spkRecord) {
    console.error(`[X3DH] ⛔ SPK #${initialMessage.spkId} NOT FOUND locally for user ${myUserId} — cannot respond to X3DH`);
    throw new Error(`X3DH: Signed prekey #${initialMessage.spkId} not found locally`);
  }

  const spkPrivate = await hardCrypto.importKey(
    'jwk', spkRecord.privateKeyJWK,
    KX_KEY_PARAMS as any,
    true, // extractable: needed for CryptoKeyPair usage in ratchet
    ['deriveBits'],
  );

  const spkPublic = await hardCrypto.importKey(
    'raw', base64ToBuffer(spkRecord.publicKeyBase64),
    KX_KEY_PARAMS as any,
    true,
    [],
  );

  // 3. Compute DH operations (Bob's perspective, reversed)
  // DH1 = DH(SPKb_priv, IKa_pub)
  const dh1 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceIK } as any,
    spkPrivate,
    256,
  );

  // DH2 = DH(IKb_priv, EKa_pub)
  const dh2 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceEK } as any,
    myKeys.privateKey,
    256,
  );

  // DH3 = DH(SPKb_priv, EKa_pub)
  const dh3 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceEK } as any,
    spkPrivate,
    256,
  );

  // DH4 = DH(OPKb_priv, EKa_pub) — optional
  let dh4: ArrayBuffer | null = null;
  if (initialMessage.opkId !== undefined) {
    const { loadPrivatePrekey } = await import('./prekeys');
    const opkPrivate = await loadPrivatePrekey(myUserId, initialMessage.opkId);
    if (opkPrivate) {
      dh4 = await hardCrypto.deriveBits(
        { name: 'X25519', public: aliceEK } as any,
        opkPrivate,
        256,
      );
      console.log(`[X3DH] OPK #${initialMessage.opkId} used for 4-DH respond`);
    } else {
      console.warn(`[X3DH] ⚠️ OPK #${initialMessage.opkId} consumed on server but NOT FOUND locally — session may have been partially established before. Using 3-DH.`);
    }
  }

  const filler = new Uint8Array(32).fill(0xFF);
  const dhConcat = dh4
    ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4)
    : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);

  const sharedSecret = await x3dhKDF(dhConcat);

  console.log(`[X3DH] ✅ Responded with ${dh4 ? '4' : '3'} DH operations (SPK #${initialMessage.spkId})`);

  // Return the SPK key pair so the responder can use it as initial ratchet DH pair
  // (per Signal spec: Bob's SPK serves as his initial ratchet key)
  return {
    sharedSecret,
    spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate },
  };
}

// ─── PQXDH Structure (Future-Ready) ───

/**
 * PQXDH extends X3DH by adding a KEM (Key Encapsulation Mechanism) step.
 * When ML-KEM-768 becomes available in Web Crypto:
 * 
 * 1. Alice fetches Bob's KEM public key alongside his prekey bundle
 * 2. (kemCT, kemSS) = KEM.Encapsulate(bobKemPK)
 * 3. SK = KDF(DH1 || DH2 || DH3 [|| DH4] || kemSS)
 * 4. kemCT is sent alongside the initial message
 * 
 * Bob decapsulates: kemSS = KEM.Decapsulate(kemCT, bobKemSK)
 * Then derives the same SK.
 * 
 * This provides post-quantum security: an attacker must break BOTH
 * X25519 AND ML-KEM-768 to compromise the shared secret.
 * 
 * Status: Structurally ready. Activate when browsers ship ML-KEM.
 */
export function isPQXDHAvailable(): boolean {
  try {
    return false;
  } catch {
    return false;
  }
}

// ─── Internal Helpers ───

async function importX25519Public(base64: string): Promise<CryptoKey> {
  return hardCrypto.importKey(
    'raw', base64ToBuffer(base64),
    KX_KEY_PARAMS as any, true, [],
  );
}

/**
 * X3DH KDF: HKDF-SHA-256 with zero salt (per Signal spec).
 * Returns 32 bytes of key material for Double Ratchet root key.
 */
async function x3dhKDF(ikm: ArrayBuffer): Promise<ArrayBuffer> {
  const hkdfKey = await hardCrypto.importKey(
    'raw', ikm, 'HKDF', false, ['deriveBits'],
  );

  // Salt: 32 zero bytes (Signal X3DH spec)
  const salt = new Uint8Array(X3DH_SALT_BYTES);
  const info = encodeString(X3DH_INFO);

  return hardCrypto.deriveBits(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    hkdfKey,
    256, // 32 bytes
  );
}
