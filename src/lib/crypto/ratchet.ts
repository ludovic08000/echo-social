/**
 * ForSure Double Ratchet
 *
 * X25519 DH ratchet + HMAC-SHA-256 symmetric chains + AES-256-GCM.
 * State transitions are returned only after authenticated decryption succeeds.
 */

import { kdfChainStep, kdfChainStepExportable, kdfRootStep } from './kdfChain';
import {
  bufferToBase64,
  base64ToBuffer,
  encodeString,
  randomBytes,
  decodeString,
  importOkpPublicKeyFromBase64,
  exportKeyToJWK,
  importKeyFromJWK,
} from './utils';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import {
  AES_ALGO, IV_LENGTH, PROTOCOL_VERSION, AD_PREFIX_V3, AD_HEADER_PREFIX_V4,
  CLASSICAL_KEM_ID, KX_KEY_PARAMS,
  RATCHET_MAX_SKIP, RATCHET_MAX_SKIPPED_CACHE, RATCHET_SKIPPED_TTL_MS,
} from './constants';
import { exportPublicKeyRaw } from './keyManager';
import { wrapSkippedJwk, unwrapSkippedJwk, isWrappedSkippedEntry } from './skippedKeyWrap';
import { padPlaintext, unpadPlaintext } from './lengthPadding';

export interface RatchetState {
  conversationId: string;
  dhSendingPair: CryptoKeyPair;
  dhReceivingKey: CryptoKey | null;
  rootKey: CryptoKey;
  sendingChainKey: CryptoKey | null;
  receivingChainKey: CryptoKey | null;
  sendCount: number;
  recvCount: number;
  prevSendCount: number;
  skippedKeys: Map<string, { key: CryptoKey; ts: number }>;
  myIdentityKeyB64?: string;
  peerIdentityKeyB64?: string;
  role?: 'initiator' | 'responder';
}

export interface RatchetHeader {
  dh: string;
  pn: number;
  n: number;
}

export interface RatchetEnvelope {
  v: number;
  kem: string;
  hdr: RatchetHeader;
  iv: string;
  ct: string;
  sig: string;
  /** Signature format. Undefined/1 is the historical header|iv|ct|ts format. */
  sigv?: 1 | 2;
  fp: string;
  ts: number;
  pad?: 0 | 1;
}

const MAX_SKIP = RATCHET_MAX_SKIP;
const MIN_SUPPORTED_VERSION = 2;

export interface RatchetReadiness {
  canEncrypt: boolean;
  canDecrypt: boolean;
  reason: 'missing_state' | 'missing_root_key' | 'missing_sending_chain' | 'missing_sending_pair' | 'missing_peer_dh' | 'ready';
}

export function getRatchetReadiness(state: RatchetState | null | undefined): RatchetReadiness {
  if (!state) return { canEncrypt: false, canDecrypt: false, reason: 'missing_state' };
  if (!state.rootKey) return { canEncrypt: false, canDecrypt: false, reason: 'missing_root_key' };
  if (!state.dhSendingPair?.publicKey || !state.dhSendingPair?.privateKey) {
    return { canEncrypt: false, canDecrypt: false, reason: 'missing_sending_pair' };
  }

  const canDecrypt = !!state.rootKey && !!state.dhSendingPair.privateKey;
  if (!state.dhReceivingKey) return { canEncrypt: false, canDecrypt, reason: 'missing_peer_dh' };
  if (!state.sendingChainKey) return { canEncrypt: false, canDecrypt, reason: 'missing_sending_chain' };
  return { canEncrypt: true, canDecrypt: true, reason: 'ready' };
}

export function isRatchetReadyForEncrypt(state: RatchetState | null | undefined): boolean {
  return getRatchetReadiness(state).canEncrypt;
}

export function isRatchetReadyForDecrypt(state: RatchetState | null | undefined): boolean {
  return getRatchetReadiness(state).canDecrypt;
}

export async function initRatchetAsInitiator(
  conversationId: string,
  sharedSecret: ArrayBuffer,
  peerDhPublicKey: CryptoKey,
  identityKeys?: { myIdentityKeyB64: string; peerIdentityKeyB64: string },
): Promise<RatchetState> {
  const dhPair = await hardCrypto.generateKey(
    KX_KEY_PARAMS as any, true, ['deriveBits'],
  ) as CryptoKeyPair;

  const rootKey = await hardCrypto.importKey(
    'raw', sharedSecret.slice(0, 32),
    { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
    true, ['sign'],
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

export async function initRatchetAsResponder(
  conversationId: string,
  sharedSecret: ArrayBuffer,
  ourDhPair: CryptoKeyPair,
  identityKeys?: { myIdentityKeyB64: string; peerIdentityKeyB64: string },
): Promise<RatchetState> {
  const rootKey = await hardCrypto.importKey(
    'raw', sharedSecret.slice(0, 32),
    { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
    true, ['sign'],
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
    myIdentityKeyB64: identityKeys?.myIdentityKeyB64,
    peerIdentityKeyB64: identityKeys?.peerIdentityKeyB64,
    role: 'responder',
  };
}

function buildAssociatedData(
  state: Pick<RatchetState, 'myIdentityKeyB64' | 'peerIdentityKeyB64' | 'role'>,
): Uint8Array | null {
  const my = state.myIdentityKeyB64;
  const peer = state.peerIdentityKeyB64;
  const role = state.role;
  if (!my || !peer || !role) return null;
  const initiatorIK = role === 'initiator' ? my : peer;
  const responderIK = role === 'initiator' ? peer : my;
  return new Uint8Array(encodeString(`${AD_PREFIX_V3}${initiatorIK}|${responderIK}`));
}

function buildAssociatedDataV4(
  state: Pick<RatchetState, 'myIdentityKeyB64' | 'peerIdentityKeyB64' | 'role'>,
  header: RatchetHeader,
): Uint8Array | null {
  const idAd = buildAssociatedData(state);
  if (!idAd) return null;
  const hdrAd = encodeString(`${AD_HEADER_PREFIX_V4}${header.dh}|${header.pn}|${header.n}`);
  const out = new Uint8Array(idAd.byteLength + hdrAd.byteLength);
  out.set(idAd, 0);
  out.set(new Uint8Array(hdrAd), idAd.byteLength);
  return out;
}

function buildLegacySignatureData(envelope: Pick<RatchetEnvelope, 'hdr' | 'iv' | 'ct' | 'ts'>): Uint8Array {
  return new Uint8Array([
    ...new Uint8Array(encodeString(hardGlobals.jsonStringify(envelope.hdr))),
    ...new Uint8Array(base64ToBuffer(envelope.iv)),
    ...new Uint8Array(base64ToBuffer(envelope.ct)),
    ...new Uint8Array(encodeString(`${envelope.ts}`)),
  ]);
}

function buildSignatureDataV2(envelope: Pick<RatchetEnvelope, 'v' | 'kem' | 'hdr' | 'iv' | 'ct' | 'fp' | 'ts' | 'pad'>): Uint8Array {
  return new Uint8Array(encodeString(
    `FORSURE-RATCHET-SIG-v2|${envelope.v}|${envelope.kem}|${envelope.hdr.dh}|${envelope.hdr.pn}|${envelope.hdr.n}|${envelope.iv}|${envelope.ct}|${envelope.fp}|${envelope.ts}|${envelope.pad ?? 0}`,
  ));
}

function validateEnvelope(envelope: RatchetEnvelope): void {
  if (!Number.isInteger(envelope.v) || envelope.v < MIN_SUPPORTED_VERSION || envelope.v > PROTOCOL_VERSION) {
    throw new Error('RATCHET_UNSUPPORTED_VERSION');
  }
  if (envelope.kem !== CLASSICAL_KEM_ID) throw new Error('RATCHET_UNSUPPORTED_KEM');
  if (!envelope.hdr || typeof envelope.hdr.dh !== 'string' || envelope.hdr.dh.length === 0) {
    throw new Error('RATCHET_INVALID_HEADER');
  }
  for (const counter of [envelope.hdr.pn, envelope.hdr.n]) {
    if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('RATCHET_INVALID_COUNTER');
  }
  if (!Number.isFinite(envelope.ts) || envelope.ts <= 0) throw new Error('RATCHET_INVALID_TIMESTAMP');
  if (envelope.pad !== undefined && envelope.pad !== 0 && envelope.pad !== 1) {
    throw new Error('RATCHET_INVALID_PADDING_FLAG');
  }
}

function paramsForDeclaredVersion(
  envelope: RatchetEnvelope,
  state?: Pick<RatchetState, 'myIdentityKeyB64' | 'peerIdentityKeyB64' | 'role'>,
): AesGcmParams {
  const iv = new Uint8Array(base64ToBuffer(envelope.iv));
  if (envelope.v === 2) return { name: AES_ALGO, iv, tagLength: 128 };
  if (!state) throw new Error('RATCHET_IDENTITY_AAD_STATE_MISSING');

  if (envelope.v === 3) {
    const ad = buildAssociatedData(state);
    if (!ad) throw new Error('RATCHET_V3_AAD_MISSING');
    return { name: AES_ALGO, iv, tagLength: 128, additionalData: ad };
  }

  if (envelope.v === 4) {
    const ad = buildAssociatedDataV4(state, envelope.hdr);
    if (!ad) throw new Error('RATCHET_V4_AAD_MISSING');
    return { name: AES_ALGO, iv, tagLength: 128, additionalData: ad };
  }

  throw new Error('RATCHET_UNSUPPORTED_VERSION');
}

export async function ratchetEncrypt(
  state: RatchetState,
  plaintext: string,
  signingKey: CryptoKey,
  fingerprint: string,
): Promise<{ envelope: RatchetEnvelope; newState: RatchetState }> {
  if (!state.sendingChainKey) throw new Error('Sending chain not initialized — wait for first incoming message');

  const { nextChainKey, messageKey } = await kdfChainStep(state.sendingChainKey);
  const dhPubRaw = await exportPublicKeyRaw(state.dhSendingPair.publicKey);
  const header: RatchetHeader = {
    dh: bufferToBase64(dhPubRaw),
    pn: state.prevSendCount,
    n: state.sendCount,
  };

  const ad = buildAssociatedDataV4(state, header);
  if (!ad) {
    throw new Error('E_RATCHET_V4_REQUIRED: ratchet state missing identity keys / role — re-run X3DH.');
  }

  const iv = randomBytes(IV_LENGTH);
  const padded = padPlaintext(plaintext);
  const ct = await hardCrypto.encrypt({
    name: AES_ALGO,
    iv: iv.slice() as Uint8Array<ArrayBuffer>,
    tagLength: 128,
    additionalData: ad as Uint8Array<ArrayBuffer>,
  }, messageKey, padded);

  const envelope: RatchetEnvelope = {
    v: PROTOCOL_VERSION,
    kem: CLASSICAL_KEM_ID,
    hdr: header,
    iv: bufferToBase64(iv.buffer as ArrayBuffer),
    ct: bufferToBase64(ct as ArrayBuffer),
    sig: '',
    sigv: 2,
    fp: fingerprint,
    ts: Date.now(),
    pad: 1,
  };
  const sig = await hardCrypto.sign('Ed25519' as any, signingKey, buildSignatureDataV2(envelope));
  envelope.sig = bufferToBase64(sig);

  return {
    envelope,
    newState: { ...state, sendingChainKey: nextChainKey, sendCount: state.sendCount + 1 },
  };
}

export async function ratchetDecrypt(
  state: RatchetState,
  envelope: RatchetEnvelope,
  peerSigningKeyBase64?: string,
): Promise<{ plaintext: string; verified: boolean; newState: RatchetState }> {
  validateEnvelope(envelope);

  const headerDhRaw = base64ToBuffer(envelope.hdr.dh);
  const headerDhKey = await hardCrypto.importKey('raw', headerDhRaw, KX_KEY_PARAMS as any, true, []);
  let newState = { ...state, skippedKeys: new Map(state.skippedKeys) };

  const skipKey = `${envelope.hdr.dh}:${envelope.hdr.n}`;
  const cachedEntry = newState.skippedKeys.get(skipKey);
  if (cachedEntry) {
    newState.skippedKeys.delete(skipKey);
    const result = await decryptWithKey(cachedEntry.key, envelope, peerSigningKeyBase64, newState);
    return { ...result, newState };
  }

  const currentDhPub = newState.dhReceivingKey
    ? bufferToBase64(await exportPublicKeyRaw(newState.dhReceivingKey))
    : null;

  if (currentDhPub !== envelope.hdr.dh) {
    if (newState.receivingChainKey) newState = await skipMessages(newState, envelope.hdr.pn);

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

    const newDhPair = await hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']) as CryptoKeyPair;
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

  newState = await skipMessages(newState, envelope.hdr.n);
  if (!newState.receivingChainKey) throw new Error('No receiving chain');
  const { nextChainKey, messageKey } = await kdfChainStep(newState.receivingChainKey);
  newState.receivingChainKey = nextChainKey;
  newState.recvCount = envelope.hdr.n + 1;

  const result = await decryptWithKey(messageKey, envelope, peerSigningKeyBase64, newState);
  return { ...result, newState };
}

async function skipMessages(state: RatchetState, until: number): Promise<RatchetState> {
  const newState = { ...state, skippedKeys: new Map(state.skippedKeys) };
  if (!newState.receivingChainKey) return newState;

  const toSkip = until - newState.recvCount;
  if (toSkip > MAX_SKIP) throw new Error('Too many skipped messages');
  if (toSkip <= 0) return newState;

  const dhPub = newState.dhReceivingKey
    ? bufferToBase64(await exportPublicKeyRaw(newState.dhReceivingKey))
    : 'init';
  let ck = newState.receivingChainKey;
  const now = Date.now();
  for (let i = newState.recvCount; i < until; i++) {
    const { nextChainKey, messageKey } = await kdfChainStepExportable(ck);
    newState.skippedKeys.set(`${dhPub}:${i}`, { key: messageKey, ts: now });
    ck = nextChainKey;
  }
  newState.receivingChainKey = ck;
  newState.recvCount = until;

  const cutoff = now - RATCHET_SKIPPED_TTL_MS;
  for (const [key, value] of newState.skippedKeys) {
    if (value.ts < cutoff) newState.skippedKeys.delete(key);
  }
  if (newState.skippedKeys.size > RATCHET_MAX_SKIPPED_CACHE) {
    const overflow = newState.skippedKeys.size - RATCHET_MAX_SKIPPED_CACHE;
    const iterator = newState.skippedKeys.keys();
    for (let i = 0; i < overflow; i++) {
      const key = iterator.next().value as string | undefined;
      if (key) newState.skippedKeys.delete(key);
    }
  }
  return newState;
}

async function decryptWithKey(
  messageKey: CryptoKey,
  envelope: RatchetEnvelope,
  peerSigningKeyBase64?: string,
  state?: Pick<RatchetState, 'myIdentityKeyB64' | 'peerIdentityKeyB64' | 'role'>,
): Promise<{ plaintext: string; verified: boolean }> {
  const ct = base64ToBuffer(envelope.ct);
  const params = paramsForDeclaredVersion(envelope, state);
  const ptBuf = await hardCrypto.decrypt(params, messageKey, ct);

  const plaintext = envelope.pad === 1
    ? unpadPlaintext(new Uint8Array(ptBuf))
    : decodeString(ptBuf);

  let verified = false;
  if (peerSigningKeyBase64) {
    try {
      const sigKey = await importOkpPublicKeyFromBase64(peerSigningKeyBase64, 'Ed25519', ['verify'], true);
      const sigData = envelope.sigv === 2
        ? buildSignatureDataV2(envelope)
        : buildLegacySignatureData(envelope);
      verified = await hardCrypto.verify(
        'Ed25519' as any,
        sigKey,
        base64ToBuffer(envelope.sig),
        sigData,
      );
    } catch {
      verified = false;
    }
  }

  return { plaintext, verified };
}

export async function serializeRatchetState(state: RatchetState): Promise<string> {
  const dhSendPubJWK = await exportKeyToJWK(state.dhSendingPair.publicKey);
  const dhSendPrivJWK = await exportKeyToJWK(state.dhSendingPair.privateKey);
  const dhRecvJWK = state.dhReceivingKey ? await exportKeyToJWK(state.dhReceivingKey) : null;
  const rootJWK = await exportKeyToJWK(state.rootKey);
  const sendCKJWK = state.sendingChainKey ? await exportKeyToJWK(state.sendingChainKey) : null;
  const recvCKJWK = state.receivingChainKey ? await exportKeyToJWK(state.receivingChainKey) : null;

  const skippedEntries: [string, string, number][] = [];
  for (const [key, value] of state.skippedKeys) {
    const jwk = await exportKeyToJWK(value.key);
    skippedEntries.push([key, await wrapSkippedJwk(jwk), value.ts]);
  }

  return hardGlobals.jsonStringify({
    conversationId: state.conversationId,
    dhSendPubJWK,
    dhSendPrivJWK,
    dhRecvJWK,
    rootJWK,
    sendCKJWK,
    recvCKJWK,
    sendCount: state.sendCount,
    recvCount: state.recvCount,
    prevSendCount: state.prevSendCount,
    skippedEntries,
    skippedFormat: 'wrapped-v1',
    myIdentityKeyB64: state.myIdentityKeyB64 ?? null,
    peerIdentityKeyB64: state.peerIdentityKeyB64 ?? null,
    role: state.role ?? null,
  });
}

export async function deserializeRatchetState(json: string): Promise<RatchetState> {
  const d = hardGlobals.jsonParse(json);
  const dhSendPub = await importKeyFromJWK(d.dhSendPubJWK, KX_KEY_PARAMS as any, [], true);
  const dhSendPriv = await importKeyFromJWK(d.dhSendPrivJWK, KX_KEY_PARAMS as any, ['deriveBits'], true);
  const dhRecv = d.dhRecvJWK ? await importKeyFromJWK(d.dhRecvJWK, KX_KEY_PARAMS as any, [], true) : null;
  const rootKey = await importKeyFromJWK(d.rootJWK, { name: 'HMAC', hash: 'SHA-256' } as AlgorithmIdentifier, ['sign'], true);
  const sendCK = d.sendCKJWK ? await importKeyFromJWK(d.sendCKJWK, { name: 'HMAC', hash: 'SHA-256' } as any, ['sign'], true) : null;
  const recvCK = d.recvCKJWK ? await importKeyFromJWK(d.recvCKJWK, { name: 'HMAC', hash: 'SHA-256' } as any, ['sign'], true) : null;

  const skippedKeys = new Map<string, { key: CryptoKey; ts: number }>();
  const now = Date.now();
  for (const entry of (d.skippedEntries || []) as Array<[string, unknown, number?]>) {
    const [keyId, raw, ts] = entry;
    let jwk: JsonWebKey | null = null;
    if (isWrappedSkippedEntry(raw)) jwk = await unwrapSkippedJwk(raw);
    else if (raw && typeof raw === 'object') jwk = raw as JsonWebKey;
    if (!jwk) continue;
    const key = await importKeyFromJWK(jwk, { name: AES_ALGO } as any, ['encrypt', 'decrypt'], true);
    skippedKeys.set(keyId, { key, ts: typeof ts === 'number' ? ts : now });
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
