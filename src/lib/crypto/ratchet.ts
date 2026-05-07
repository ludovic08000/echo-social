/**
 * ForSure Double Ratchet
 * 
 * Signal-style Double Ratchet combining:
 *   1. DH Ratchet (X25519) — new ephemeral keys per turn
 *   2. Symmetric Ratchet (HMAC-SHA-256 KDF chain) — new key per message
 * 
 * Provides:
 *   - Forward secrecy per message
 *   - Break-in recovery (future secrecy)
 *   - Out-of-order message decryption (skipped message keys cache)
 * 
 * State stored locally in IndexedDB, never on server.
 */

import { kdfChainStep, kdfChainStepExportable, kdfRootStep } from './kdfChain';
import {
  bufferToBase64,
  base64ToBuffer,
  encodeString,
  randomBytes,
  decodeString,
  importOkpPublicKeyFromBase64,
} from './utils';
import { exportKeyToJWK, importKeyFromJWK } from './utils';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import {
  AES_ALGO, IV_LENGTH, PROTOCOL_VERSION, AD_PREFIX_V3, AD_HEADER_PREFIX_V4,
  CLASSICAL_KEM_ID, KX_KEY_PARAMS,
  RATCHET_MAX_SKIP, RATCHET_MAX_SKIPPED_CACHE, RATCHET_SKIPPED_TTL_MS,
} from './constants';
import { exportPublicKeyRaw } from './keyManager';

// ─── Types ───

export interface RatchetState {
  conversationId: string;
  /** Our current DH ratchet key pair */
  dhSendingPair: CryptoKeyPair;
  /** Peer's current DH ratchet public key */
  dhReceivingKey: CryptoKey | null;
  /** Root key for DH ratchet steps */
  rootKey: CryptoKey;
  /** Sending chain key */
  sendingChainKey: CryptoKey | null;
  /** Receiving chain key */
  receivingChainKey: CryptoKey | null;
  /** Message counters */
  sendCount: number;
  recvCount: number;
  /** Previous sending chain length (for header) */
  prevSendCount: number;
  /** Skipped message keys: Map<"dhPub:msgNum", { key, createdAt }> with TTL purge */
  skippedKeys: Map<string, { key: CryptoKey; ts: number }>;
  /**
   * Identity keys snapshot at X3DH time. Used to build AES-GCM Associated
   * Data (AD = "FORSURE-AD-v3|" || base64(IKa) || "|" || base64(IKb)) so
   * the ciphertext is cryptographically bound to the conversation parties
   * (Signal X3DH spec §3.3). Optional for backward-compat with v2 states
   * loaded from disk before the upgrade.
   */
  myIdentityKeyB64?: string;
  peerIdentityKeyB64?: string;
  /**
   * X3DH role for canonical AD ordering (initiator IK first). Optional for
   * backward-compat with v2 states loaded from disk before the upgrade.
   */
  role?: 'initiator' | 'responder';
}

export interface RatchetHeader {
  /** Sender's current DH ratchet public key (base64) */
  dh: string;
  /** Previous chain message count */
  pn: number;
  /** Message number in current chain */
  n: number;
}

export interface RatchetEnvelope {
  v: number;
  kem: string;
  hdr: RatchetHeader;
  iv: string;
  ct: string;
  sig: string;
  fp: string;
  ts: number;
}

const MAX_SKIP = RATCHET_MAX_SKIP; // Signal-conformant DoS protection ceiling

export interface RatchetReadiness {
  canEncrypt: boolean;
  canDecrypt: boolean;
  reason: 'missing_state' | 'missing_root_key' | 'missing_sending_chain' | 'missing_sending_pair' | 'missing_peer_dh' | 'ready';
}

/**
 * Central low-level readiness guard for Double Ratchet.
 *
 * IMPORTANT:
 * - A responder ratchet MAY legitimately exist without a sending chain yet.
 * - That state is valid for decrypt, but NOT for encrypt.
 */
export function getRatchetReadiness(state: RatchetState | null | undefined): RatchetReadiness {
  if (!state) {
    return { canEncrypt: false, canDecrypt: false, reason: 'missing_state' };
  }
  if (!state.rootKey) {
    return { canEncrypt: false, canDecrypt: false, reason: 'missing_root_key' };
  }
  if (!state.dhSendingPair?.publicKey || !state.dhSendingPair?.privateKey) {
    return { canEncrypt: false, canDecrypt: false, reason: 'missing_sending_pair' };
  }

  // A responder that has completed X3DH but has not yet received the first
  // Double Ratchet message is still decrypt-capable: the incoming header DH
  // will seed the first receiving chain from the root key.
  const canDecrypt = !!state.rootKey && !!state.dhSendingPair?.privateKey;

  if (!state.dhReceivingKey) {
    return { canEncrypt: false, canDecrypt, reason: 'missing_peer_dh' };
  }
  if (!state.sendingChainKey) {
    return { canEncrypt: false, canDecrypt, reason: 'missing_sending_chain' };
  }

  return { canEncrypt: true, canDecrypt: true, reason: 'ready' };
}

export function isRatchetReadyForEncrypt(state: RatchetState | null | undefined): boolean {
  return getRatchetReadiness(state).canEncrypt;
}

export function isRatchetReadyForDecrypt(state: RatchetState | null | undefined): boolean {
  return getRatchetReadiness(state).canDecrypt;
}

// ─── Initialize ───

/** Initialize ratchet as the initiator (Alice) */
export async function initRatchetAsInitiator(
  conversationId: string,
  sharedSecret: ArrayBuffer,
  peerDhPublicKey: CryptoKey,
  identityKeys?: { myIdentityKeyB64: string; peerIdentityKeyB64: string },
): Promise<RatchetState> {
  // Generate our first ratchet key pair
  const dhPair = await hardCrypto.generateKey(
    KX_KEY_PARAMS as any, true, ['deriveBits']
  ) as CryptoKeyPair;

  const rootKey = await hardCrypto.importKey(
    'raw', sharedSecret.slice(0, 32),
    { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
    true, ['sign']
  );

  const dhOutput = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerDhPublicKey } as any,
    dhPair.privateKey,
    256,
  );

  const { newRootKey, newChainKey } = await kdfRootStep(rootKey, dhOutput);

  return {
    conversationId,
    dhSendingPair: dhPair,
    dhReceivingKey: peerDhPublicKey,
    rootKey: newRootKey,
    sendingChainKey: newChainKey,
    receivingChainKey: null,
    sendCount: 0,
    recvCount: 0,
    prevSendCount: 0,
    skippedKeys: new Map(),
    myIdentityKeyB64: identityKeys?.myIdentityKeyB64,
    peerIdentityKeyB64: identityKeys?.peerIdentityKeyB64,
    role: 'initiator',
  };
}

/** Initialize ratchet as the responder (Bob) */
export async function initRatchetAsResponder(
  conversationId: string,
  sharedSecret: ArrayBuffer,
  ourDhPair: CryptoKeyPair,
  identityKeys?: { myIdentityKeyB64: string; peerIdentityKeyB64: string },
): Promise<RatchetState> {
  const rootKey = await hardCrypto.importKey(
    'raw', sharedSecret.slice(0, 32),
    { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
    true, ['sign']
  );

  return {
    conversationId,
    dhSendingPair: ourDhPair,
    dhReceivingKey: null,
    rootKey,
    sendingChainKey: null,
    receivingChainKey: null,
    sendCount: 0,
    recvCount: 0,
    prevSendCount: 0,
    skippedKeys: new Map(),
    // Note for responder: AD = "FORSURE-AD-v3|" || IKa || IKb (initiator first).
    // From responder's POV: peerIdentityKeyB64 = IKa (initiator), myIdentityKeyB64 = IKb (us).
    myIdentityKeyB64: identityKeys?.myIdentityKeyB64,
    peerIdentityKeyB64: identityKeys?.peerIdentityKeyB64,
    role: 'responder',
  };
}

// ─── Associated Data (Signal X3DH §3.3) ───
//
// Canonical order: initiator IK first. For sender (Alice) AD is built as
// `prefix || IKa || IKb`. For responder (Bob) it is `prefix || IKa || IKb`
// — i.e. `peerIdentityKeyB64 || myIdentityKeyB64`. The state always stores
// keys in our local frame; this helper produces the canonical shared bytes.
function buildAssociatedData(
  state: Pick<RatchetState, 'myIdentityKeyB64' | 'peerIdentityKeyB64' | 'role'>,
  roleOverride?: 'initiator' | 'responder',
): Uint8Array | null {
  const my = state.myIdentityKeyB64;
  const peer = state.peerIdentityKeyB64;
  const role = roleOverride ?? state.role;
  if (!my || !peer || !role) return null;
  const initiatorIK = role === 'initiator' ? my : peer;
  const responderIK = role === 'initiator' ? peer : my;
  return new Uint8Array(encodeString(`${AD_PREFIX_V3}${initiatorIK}|${responderIK}`));
}

// ─── Encrypt ───

export async function ratchetEncrypt(
  state: RatchetState,
  plaintext: string,
  signingKey: CryptoKey,
  fingerprint: string,
): Promise<{ envelope: RatchetEnvelope; newState: RatchetState }> {
  if (!state.sendingChainKey) {
    throw new Error('Sending chain not initialized — wait for first incoming message');
  }

  // Symmetric ratchet step
  const { nextChainKey, messageKey } = await kdfChainStep(state.sendingChainKey);

  // Build header
  const dhPubRaw = await exportPublicKeyRaw(state.dhSendingPair.publicKey);
  const header: RatchetHeader = {
    dh: bufferToBase64(dhPubRaw),
    pn: state.prevSendCount,
    n: state.sendCount,
  };

  // Encrypt with AES-256-GCM (v3: bind to identity keys via AAD if available)
  const ad = buildAssociatedData(state);
  const iv = randomBytes(IV_LENGTH);
  const encryptParams: AesGcmParams = ad
    ? { name: AES_ALGO, iv: iv.slice() as Uint8Array<ArrayBuffer>, tagLength: 128, additionalData: ad as Uint8Array<ArrayBuffer> }
    : { name: AES_ALGO, iv: iv.slice() as Uint8Array<ArrayBuffer>, tagLength: 128 };
  const ct = await hardCrypto.encrypt(
    encryptParams,
    messageKey,
    encodeString(plaintext),
  );

  const ts = Date.now();

  // Sign: header || iv || ciphertext
  const sigData = new Uint8Array([
    ...new Uint8Array(encodeString(hardGlobals.jsonStringify(header))),
    ...iv,
    ...new Uint8Array(ct as ArrayBuffer),
    ...new Uint8Array(encodeString(`${ts}`)),
  ]);

  const sig = await hardCrypto.sign('Ed25519' as any, signingKey, sigData);

  const envelope: RatchetEnvelope = {
    v: ad ? PROTOCOL_VERSION : 2,
    kem: CLASSICAL_KEM_ID,
    hdr: header,
    iv: bufferToBase64(iv.buffer as ArrayBuffer),
    ct: bufferToBase64(ct as ArrayBuffer),
    sig: bufferToBase64(sig),
    fp: fingerprint,
    ts,
  };

  return {
    envelope,
    newState: {
      ...state,
      sendingChainKey: nextChainKey,
      sendCount: state.sendCount + 1,
    },
  };
}

// ─── Decrypt ───

export async function ratchetDecrypt(
  state: RatchetState,
  envelope: RatchetEnvelope,
  peerSigningKeyBase64?: string,
): Promise<{ plaintext: string; verified: boolean; newState: RatchetState }> {
  // Anti-replay: handled by Double Ratchet header counters (pn/n) +
  // skippedKeys cache below. Timestamps are sanity-checked but never used
  // as a hard cutoff, so historical messages remain decryptable after
  // restoration (PIN re-unlock, device re-sync, key backup restore).
  if (typeof envelope.ts !== 'number' || envelope.ts <= 0) {
    throw new Error('Ratchet envelope timestamp invalide');
  }

  const headerDhRaw = base64ToBuffer(envelope.hdr.dh);
  const headerDhKey = await hardCrypto.importKey(
    'raw', headerDhRaw, KX_KEY_PARAMS as any, true, []
  );

  let newState = { ...state, skippedKeys: new Map(state.skippedKeys) };

  // Check skipped keys first
  const skipKey = `${envelope.hdr.dh}:${envelope.hdr.n}`;
  const cachedEntry = newState.skippedKeys.get(skipKey);
  if (cachedEntry) {
    newState.skippedKeys.delete(skipKey);
    const result = await decryptWithKey(cachedEntry.key, envelope, peerSigningKeyBase64, newState);
    return { ...result, newState };
  }

  // Check if DH ratchet step needed
  const currentDhPub = newState.dhReceivingKey
    ? bufferToBase64(await exportPublicKeyRaw(newState.dhReceivingKey))
    : null;

  if (currentDhPub !== envelope.hdr.dh) {
    // Skip any remaining messages in current receiving chain
    if (newState.receivingChainKey) {
      newState = await skipMessages(newState, envelope.hdr.pn);
    }

    // DH ratchet step
    const dhOutput = await hardCrypto.deriveBits(
      { name: 'X25519', public: headerDhKey } as any,
      newState.dhSendingPair.privateKey,
      256,
    );

    const { newRootKey, newChainKey: newRecvChain } = await kdfRootStep(newState.rootKey, dhOutput);
    newState.dhReceivingKey = headerDhKey;
    newState.receivingChainKey = newRecvChain;
    newState.rootKey = newRootKey;
    newState.prevSendCount = newState.sendCount;
    newState.sendCount = 0;
    newState.recvCount = 0;

    // Generate new sending pair
    const newDhPair = await hardCrypto.generateKey(
      KX_KEY_PARAMS as any, true, ['deriveBits']
    ) as CryptoKeyPair;

    const dhOutput2 = await hardCrypto.deriveBits(
      { name: 'X25519', public: headerDhKey } as any,
      newDhPair.privateKey,
      256,
    );

    const { newRootKey: rk2, newChainKey: sendChain } = await kdfRootStep(newState.rootKey, dhOutput2);
    newState.rootKey = rk2;
    newState.sendingChainKey = sendChain;
    newState.dhSendingPair = newDhPair;
  }

  // Skip messages in current chain if needed
  newState = await skipMessages(newState, envelope.hdr.n);

  // Symmetric ratchet step
  if (!newState.receivingChainKey) throw new Error('No receiving chain');
  const { nextChainKey, messageKey } = await kdfChainStep(newState.receivingChainKey);
  newState.receivingChainKey = nextChainKey;
  newState.recvCount = envelope.hdr.n + 1;

  const result = await decryptWithKey(messageKey, envelope, peerSigningKeyBase64, newState);
  return { ...result, newState };
}

// ─── Helpers ───

async function skipMessages(state: RatchetState, until: number): Promise<RatchetState> {
  const newState = { ...state, skippedKeys: new Map(state.skippedKeys) };

  if (!newState.receivingChainKey) return newState;

  const toSkip = until - newState.recvCount;
  if (toSkip > MAX_SKIP) throw new Error('Too many skipped messages');
  if (toSkip <= 0) return newState;

  // Get current DH pub for cache key
  const dhPub = newState.dhReceivingKey
    ? bufferToBase64(await exportPublicKeyRaw(newState.dhReceivingKey))
    : 'init';

  let ck = newState.receivingChainKey;
  const now = Date.now();
  for (let i = newState.recvCount; i < until; i++) {
    // Use exportable variant since skipped keys need IndexedDB persistence
    const { nextChainKey, messageKey } = await kdfChainStepExportable(ck);
    newState.skippedKeys.set(`${dhPub}:${i}`, { key: messageKey, ts: now });
    ck = nextChainKey;
  }
  newState.receivingChainKey = ck;
  newState.recvCount = until;

  // Signal-conformant pruning: TTL purge first, then size cap.
  const cutoff = now - RATCHET_SKIPPED_TTL_MS;
  for (const [k, v] of newState.skippedKeys) {
    if (v.ts < cutoff) newState.skippedKeys.delete(k);
  }
  if (newState.skippedKeys.size > RATCHET_MAX_SKIPPED_CACHE) {
    // Evict oldest first (insertion order preserved by Map).
    const overflow = newState.skippedKeys.size - RATCHET_MAX_SKIPPED_CACHE;
    const it = newState.skippedKeys.keys();
    for (let i = 0; i < overflow; i++) newState.skippedKeys.delete(it.next().value as string);
  }

  return newState;
}

async function decryptWithKey(
  messageKey: CryptoKey,
  envelope: RatchetEnvelope,
  peerSigningKeyBase64?: string,
  state?: Pick<RatchetState, 'myIdentityKeyB64' | 'peerIdentityKeyB64' | 'role'>,
): Promise<{ plaintext: string; verified: boolean }> {
  const iv = base64ToBuffer(envelope.iv);
  const ct = base64ToBuffer(envelope.ct);

  // v3 envelopes are bound to identity-keys via AES-GCM AAD. v2 envelopes
  // (legacy) carry no AAD and are still accepted for backward compatibility
  // during the migration window. We try AAD first when v>=3 and fall back to
  // no-AAD on tag mismatch — this absorbs the rare case where a v3 envelope
  // is received before the local state has identity keys cached.
  const ad = (envelope.v ?? 2) >= 3 && state ? buildAssociatedData(state) : null;
  let ptBuf: ArrayBuffer;
  if (ad) {
    try {
      ptBuf = await hardCrypto.decrypt(
        { name: AES_ALGO, iv: new Uint8Array(iv), tagLength: 128, additionalData: ad as Uint8Array<ArrayBuffer> } as AesGcmParams,
        messageKey,
        ct,
      );
    } catch {
      ptBuf = await hardCrypto.decrypt(
        { name: AES_ALGO, iv: new Uint8Array(iv), tagLength: 128 },
        messageKey,
        ct,
      );
    }
  } else {
    ptBuf = await hardCrypto.decrypt(
      { name: AES_ALGO, iv: new Uint8Array(iv), tagLength: 128 },
      messageKey,
      ct,
    );
  }

  const plaintext = decodeString(ptBuf);

  // Verify Ed25519 signature
  let verified = false;
  if (peerSigningKeyBase64) {
    try {
      const sigKey = await importOkpPublicKeyFromBase64(peerSigningKeyBase64, 'Ed25519', ['verify'], true);
      const sigData = new Uint8Array([
        ...new Uint8Array(encodeString(hardGlobals.jsonStringify(envelope.hdr))),
        ...new Uint8Array(iv),
        ...new Uint8Array(ct),
        ...new Uint8Array(encodeString(`${envelope.ts}`)),
      ]);
      verified = await hardCrypto.verify(
        'Ed25519' as any, sigKey, base64ToBuffer(envelope.sig), sigData,
      );
    } catch {
      verified = false;
    }
  }

  return { plaintext, verified };
}

// ─── Serialization (for IndexedDB) ───

export async function serializeRatchetState(state: RatchetState): Promise<string> {
  const dhSendPubJWK = await exportKeyToJWK(state.dhSendingPair.publicKey);
  const dhSendPrivJWK = await exportKeyToJWK(state.dhSendingPair.privateKey);
  const dhRecvJWK = state.dhReceivingKey ? await exportKeyToJWK(state.dhReceivingKey) : null;
  const rootJWK = await exportKeyToJWK(state.rootKey);
  const sendCKJWK = state.sendingChainKey ? await exportKeyToJWK(state.sendingChainKey) : null;
  const recvCKJWK = state.receivingChainKey ? await exportKeyToJWK(state.receivingChainKey) : null;

  // Serialize skipped keys
  const skippedEntries: [string, JsonWebKey][] = [];
  for (const [k, v] of state.skippedKeys) {
    skippedEntries.push([k, await exportKeyToJWK(v)]);
  }

  return hardGlobals.jsonStringify({
    conversationId: state.conversationId,
    dhSendPubJWK, dhSendPrivJWK, dhRecvJWK,
    rootJWK, sendCKJWK, recvCKJWK,
    sendCount: state.sendCount,
    recvCount: state.recvCount,
    prevSendCount: state.prevSendCount,
    skippedEntries,
    myIdentityKeyB64: state.myIdentityKeyB64 ?? null,
    peerIdentityKeyB64: state.peerIdentityKeyB64 ?? null,
    role: state.role ?? null,
  });
}

export async function deserializeRatchetState(json: string): Promise<RatchetState> {
  const d = hardGlobals.jsonParse(json);

  // Signal-style extractability rules:
  // ALL keys that need re-serialization MUST be extractable.
  // In Signal's libsignal, keys are stored as raw bytes — Web Crypto requires
  // extractable=true for any key that will be exported to JWK for IndexedDB persistence.
  //
  // - Public keys: EXTRACTABLE (headers + DH comparison + re-serialization)
  // - Private keys: EXTRACTABLE (deriveBits + re-serialization after state update)
  // - Root key: EXTRACTABLE (HKDF salt export + re-serialization)
  // - Chain keys: EXTRACTABLE (HMAC chain + re-serialization)
  // - Skipped message keys: EXTRACTABLE (re-serialization to IndexedDB)
  const dhSendPub = await importKeyFromJWK(d.dhSendPubJWK, KX_KEY_PARAMS as any, [], true);
  const dhSendPriv = await importKeyFromJWK(d.dhSendPrivJWK, KX_KEY_PARAMS as any, ['deriveBits'], true);
  const dhRecv = d.dhRecvJWK ? await importKeyFromJWK(d.dhRecvJWK, KX_KEY_PARAMS as any, [], true) : null;
  const rootKey = await importKeyFromJWK(d.rootJWK, { name: 'HMAC', hash: 'SHA-256' } as AlgorithmIdentifier, ['sign'], true);
  const sendCK = d.sendCKJWK ? await importKeyFromJWK(d.sendCKJWK, { name: 'HMAC', hash: 'SHA-256' } as any, ['sign'], true) : null;
  const recvCK = d.recvCKJWK ? await importKeyFromJWK(d.recvCKJWK, { name: 'HMAC', hash: 'SHA-256' } as any, ['sign'], true) : null;

  // Skipped message keys also need extractable=true for re-serialization
  const skippedKeys = new Map<string, CryptoKey>();
  for (const [k, jwk] of d.skippedEntries || []) {
    skippedKeys.set(k, await importKeyFromJWK(jwk as any, { name: AES_ALGO } as any, ['encrypt', 'decrypt'], true));
  }

  return {
    conversationId: d.conversationId,
    dhSendingPair: { publicKey: dhSendPub, privateKey: dhSendPriv },
    dhReceivingKey: dhRecv,
    rootKey,
    sendingChainKey: sendCK,
    receivingChainKey: recvCK,
    sendCount: d.sendCount,
    recvCount: d.recvCount,
    prevSendCount: d.prevSendCount,
    skippedKeys,
    myIdentityKeyB64: d.myIdentityKeyB64 ?? undefined,
    peerIdentityKeyB64: d.peerIdentityKeyB64 ?? undefined,
    role: (d.role as 'initiator' | 'responder' | null) ?? undefined,
  };
}
