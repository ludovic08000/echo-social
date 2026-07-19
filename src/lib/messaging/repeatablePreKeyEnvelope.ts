import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { runTxOn, reqToPromise } from '@/lib/crypto/indexedDbTx';
import { getOrCreateIdentityKeys, exportPublicKeyRaw } from '@/lib/crypto/keyManager';
import {
  establishDeviceSession,
  invalidateDeviceSession,
  ratchetDecryptWithSession,
  ratchetEncrypt,
  AEGIS_RATCHET_PREFIX,
} from '@/lib/crypto/deviceRatchet';
import {
  fetchPrekeyBundleForDevice,
  x3dhInitiate,
} from '@/lib/crypto/x3dh';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';

const SESSION_STORE = 'sessions';
const INITIATING_STORE = 'initiating-sessions';
const PREFIX = 'aegis1.init.v1.';
const MAC_INFO = 'ForSure-Aegis-device-init-v1';
const INITIATING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INITIATING_MESSAGES = 100;

interface StoredSessionRecord extends Record<string, unknown> {
  id: string;
  sessionId: string;
}

export interface InitiatingEnvelopeRecord {
  id: string;
  sessionId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  senderIdentityKeyB64: string;
  recipientIdentityKeyB64: string;
  ekB64: string;
  spkId: number;
  opkId?: number;
  macKeyB64: string;
  createdAt: number;
  expiresAt: number;
  messageCount: number;
}

export interface ParsedRepeatablePreKeyEnvelope {
  sessionId: string;
  ekB64: string;
  spkId: number;
  opkId?: number;
  senderIdentityKeyB64: string;
  recipientIdentityKeyB64: string;
  innerRatchet: string;
  tagB64: string;
}

type PairSnapshot = {
  session: StoredSessionRecord | null;
  initiating: InitiatingEnvelopeRecord | null;
};

function pairKey(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
): string {
  return `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`;
}

function parseRatchetSessionId(payload: string): string | null {
  if (!payload.startsWith(AEGIS_RATCHET_PREFIX)) return null;
  const parts = payload.slice(AEGIS_RATCHET_PREFIX.length).split('.');
  if (parts.length !== 6 || !parts[0]) return null;
  return parts[0];
}

function utf8ToBase64(value: string): string {
  const bytes = new hardGlobals.TextEncoder().encode(value);
  return bufferToBase64(bytes.buffer as ArrayBuffer);
}

function base64ToUtf8(value: string): string {
  return new hardGlobals.TextDecoder().decode(base64ToBuffer(value));
}

function canonicalMacPayload(args: {
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  sessionId: string;
  senderIdentityKeyB64: string;
  recipientIdentityKeyB64: string;
  ekB64: string;
  spkId: number;
  opkId?: number;
  innerRatchet: string;
}): Uint8Array {
  return new hardGlobals.TextEncoder().encode(JSON.stringify({
    context: MAC_INFO,
    sender: {
      userId: args.senderUserId,
      deviceId: args.senderDeviceId,
      identityKey: args.senderIdentityKeyB64,
    },
    recipient: {
      userId: args.recipientUserId,
      deviceId: args.recipientDeviceId,
      identityKey: args.recipientIdentityKeyB64,
    },
    sessionId: args.sessionId,
    x3dh: {
      ek: args.ekB64,
      spkId: args.spkId,
      opkId: args.opkId ?? null,
    },
    innerRatchet: args.innerRatchet,
  }));
}

async function deriveMacKeyB64(sharedSecret: ArrayBuffer): Promise<string> {
  const ikm = await hardCrypto.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const bits = await hardCrypto.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(32),
    info: new hardGlobals.TextEncoder().encode(MAC_INFO),
  } as HkdfParams, ikm, 256);
  return bufferToBase64(bits);
}

async function signEnvelope(record: InitiatingEnvelopeRecord, innerRatchet: string): Promise<string> {
  const key = await hardCrypto.importKey(
    'raw',
    base64ToBuffer(record.macKeyB64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await hardCrypto.sign(
    'HMAC',
    key,
    canonicalMacPayload({
      senderUserId: record.senderUserId,
      senderDeviceId: record.senderDeviceId,
      recipientUserId: record.recipientUserId,
      recipientDeviceId: record.recipientDeviceId,
      sessionId: record.sessionId,
      senderIdentityKeyB64: record.senderIdentityKeyB64,
      recipientIdentityKeyB64: record.recipientIdentityKeyB64,
      ekB64: record.ekB64,
      spkId: record.spkId,
      opkId: record.opkId,
      innerRatchet,
    }),
  );
  return bufferToBase64(signature);
}

async function verifyEnvelopeTag(
  parsed: ParsedRepeatablePreKeyEnvelope,
  macKeyB64: string,
  senderUserId: string,
  senderDeviceId: string,
  recipientUserId: string,
  recipientDeviceId: string,
): Promise<boolean> {
  const key = await hardCrypto.importKey(
    'raw',
    base64ToBuffer(macKeyB64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return hardCrypto.verify(
    'HMAC',
    key,
    base64ToBuffer(parsed.tagB64),
    canonicalMacPayload({
      senderUserId,
      senderDeviceId,
      recipientUserId,
      recipientDeviceId,
      sessionId: parsed.sessionId,
      senderIdentityKeyB64: parsed.senderIdentityKeyB64,
      recipientIdentityKeyB64: parsed.recipientIdentityKeyB64,
      ekB64: parsed.ekB64,
      spkId: parsed.spkId,
      opkId: parsed.opkId,
      innerRatchet: parsed.innerRatchet,
    }),
  );
}

function encodeEnvelope(record: InitiatingEnvelopeRecord, innerRatchet: string, tagB64: string): string {
  return [
    PREFIX + record.sessionId,
    record.ekB64,
    String(record.spkId),
    record.opkId === undefined ? '0' : String(record.opkId),
    record.senderIdentityKeyB64,
    record.recipientIdentityKeyB64,
    utf8ToBase64(innerRatchet),
    tagB64,
  ].join('.');
}

export function isRepeatablePreKeyEnvelope(payload: string): boolean {
  return payload.startsWith(PREFIX);
}

export function parseRepeatablePreKeyEnvelope(payload: string): ParsedRepeatablePreKeyEnvelope | null {
  if (!isRepeatablePreKeyEnvelope(payload)) return null;
  const parts = payload.slice(PREFIX.length).split('.');
  if (parts.length !== 8) return null;

  const [sessionId, ekB64, spkIdRaw, opkIdRaw, senderIdentityKeyB64, recipientIdentityKeyB64, innerB64, tagB64] = parts;
  const spkId = Number.parseInt(spkIdRaw, 10);
  const opkId = opkIdRaw === '0' ? undefined : Number.parseInt(opkIdRaw, 10);
  if (!sessionId || !ekB64 || !senderIdentityKeyB64 || !recipientIdentityKeyB64 || !innerB64 || !tagB64) return null;
  if (!Number.isInteger(spkId) || spkId <= 0) return null;
  if (opkIdRaw !== '0' && (!Number.isInteger(opkId) || (opkId as number) <= 0)) return null;

  let innerRatchet: string;
  try {
    innerRatchet = base64ToUtf8(innerB64);
  } catch {
    return null;
  }
  if (parseRatchetSessionId(innerRatchet) !== sessionId) return null;

  return {
    sessionId,
    ekB64,
    spkId,
    opkId,
    senderIdentityKeyB64,
    recipientIdentityKeyB64,
    innerRatchet,
    tagB64,
  };
}

async function exportIdentityKeyB64(publicKey: CryptoKey): Promise<string> {
  const raw = await exportPublicKeyRaw(publicKey);
  return bufferToBase64(raw);
}

async function readSession(key: string): Promise<StoredSessionRecord | null> {
  const value = await runTxOn('device-sessions', [SESSION_STORE], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(SESSION_STORE).get(key) as IDBRequest<StoredSessionRecord | undefined>),
  );
  return value ?? null;
}

async function readInitiating(key: string): Promise<InitiatingEnvelopeRecord | null> {
  const value = await runTxOn('device-sessions', [INITIATING_STORE], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(INITIATING_STORE).get(key) as IDBRequest<InitiatingEnvelopeRecord | undefined>),
  );
  return value ?? null;
}

async function writeInitiating(record: InitiatingEnvelopeRecord): Promise<void> {
  await runTxOn('device-sessions', [INITIATING_STORE], 'readwrite', (tx) => {
    tx.objectStore(INITIATING_STORE).put(record);
  });
}

async function deleteInitiating(key: string): Promise<void> {
  await runTxOn('device-sessions', [INITIATING_STORE], 'readwrite', (tx) => {
    tx.objectStore(INITIATING_STORE).delete(key);
  });
}

async function snapshotPair(key: string): Promise<PairSnapshot> {
  const result = await runTxOn('device-sessions', [SESSION_STORE, INITIATING_STORE], 'readonly', async (tx) => {
    const [session, initiating] = await Promise.all([
      reqToPromise(tx.objectStore(SESSION_STORE).get(key) as IDBRequest<StoredSessionRecord | undefined>),
      reqToPromise(tx.objectStore(INITIATING_STORE).get(key) as IDBRequest<InitiatingEnvelopeRecord | undefined>),
    ]);
    return { session: session ?? null, initiating: initiating ?? null };
  });
  return {
    session: result.session ? structuredClone(result.session) : null,
    initiating: result.initiating ? structuredClone(result.initiating) : null,
  };
}

async function restorePair(key: string, snapshot: PairSnapshot): Promise<void> {
  await runTxOn('device-sessions', [SESSION_STORE, INITIATING_STORE], 'readwrite', (tx) => {
    const sessions = tx.objectStore(SESSION_STORE);
    const initiating = tx.objectStore(INITIATING_STORE);
    if (snapshot.session) sessions.put(structuredClone(snapshot.session));
    else sessions.delete(key);
    if (snapshot.initiating) initiating.put(structuredClone(snapshot.initiating));
    else initiating.delete(key);
  });
}

export async function clearInitiatingSessionForPair(args: {
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
}): Promise<void> {
  await deleteInitiating(pairKey(args.myUserId, args.myDeviceId, args.peerUserId, args.peerDeviceId));
}

export async function prepareInitiatingSessionForSend(args: {
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
}): Promise<'none' | 'active' | 'restart'> {
  const key = pairKey(args.myUserId, args.myDeviceId, args.peerUserId, args.peerDeviceId);
  const record = await readInitiating(key);
  if (!record) return 'none';
  const session = await readSession(key);
  const expired = Date.now() >= record.expiresAt || record.messageCount >= MAX_INITIATING_MESSAGES;
  if (!session || session.sessionId !== record.sessionId || expired) {
    await deleteInitiating(key);
    return 'restart';
  }
  return 'active';
}

export async function wrapRatchetForInitiatingSession(args: {
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
  ratchetPayload: string;
}): Promise<string> {
  const key = pairKey(args.myUserId, args.myDeviceId, args.peerUserId, args.peerDeviceId);
  const record = await readInitiating(key);
  if (!record) return args.ratchetPayload;
  const ratchetSessionId = parseRatchetSessionId(args.ratchetPayload);
  if (ratchetSessionId !== record.sessionId) {
    await deleteInitiating(key);
    return args.ratchetPayload;
  }
  if (Date.now() >= record.expiresAt || record.messageCount >= MAX_INITIATING_MESSAGES) {
    throw new Error('E2EE_INITIATING_SESSION_EXPIRED');
  }

  const tagB64 = await signEnvelope(record, args.ratchetPayload);
  const next = { ...record, messageCount: record.messageCount + 1 };
  await writeInitiating(next);
  return encodeEnvelope(record, args.ratchetPayload, tagB64);
}

export async function createRepeatablePreKeyEnvelope(args: {
  plaintext: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  useOneTimePrekey?: boolean;
}): Promise<string | null> {
  const key = pairKey(args.senderUserId, args.senderDeviceId, args.recipientUserId, args.recipientDeviceId);
  const before = await snapshotPair(key);
  try {
    const bundle = await fetchPrekeyBundleForDevice(args.recipientUserId, args.recipientDeviceId, {
      claimOneTimePrekey: args.useOneTimePrekey !== false,
    });
    if (!bundle) return null;

    const myKeys = await getOrCreateIdentityKeys(args.senderUserId);
    const senderIdentityKeyB64 = await exportIdentityKeyB64(myKeys.publicKey);
    const result = await x3dhInitiate(myKeys, bundle);
    const sessionId = await establishDeviceSession(
      args.senderUserId,
      args.senderDeviceId,
      args.recipientUserId,
      args.recipientDeviceId,
      result.sharedSecret,
      undefined,
      {
        peerInitialDhPubB64: bundle.signedPrekey,
        isInitiator: true,
        peerSpkId: bundle.signedPrekeyId,
      },
    );

    const now = Date.now();
    await writeInitiating({
      id: key,
      sessionId,
      senderUserId: args.senderUserId,
      senderDeviceId: args.senderDeviceId,
      recipientUserId: args.recipientUserId,
      recipientDeviceId: args.recipientDeviceId,
      senderIdentityKeyB64,
      recipientIdentityKeyB64: bundle.identityKey,
      ekB64: result.ephemeralKey,
      spkId: result.usedSPKId,
      opkId: result.usedOTPKId,
      macKeyB64: await deriveMacKeyB64(result.sharedSecret),
      createdAt: now,
      expiresAt: now + INITIATING_TTL_MS,
      messageCount: 0,
    });

    const innerRatchet = await ratchetEncrypt(
      args.senderUserId,
      args.senderDeviceId,
      args.recipientUserId,
      args.recipientDeviceId,
      args.plaintext,
    );
    if (!innerRatchet) throw new Error('E2EE_INITIATING_RATCHET_ENCRYPT_FAILED');

    return wrapRatchetForInitiatingSession({
      myUserId: args.senderUserId,
      myDeviceId: args.senderDeviceId,
      peerUserId: args.recipientUserId,
      peerDeviceId: args.recipientDeviceId,
      ratchetPayload: innerRatchet,
    });
  } catch (error) {
    await restorePair(key, before).catch(() => undefined);
    throw error;
  }
}

export async function unwrapRepeatablePreKeyEnvelope(args: {
  payload: string;
  recipientUserId: string;
  recipientDeviceId: string;
  senderUserId: string;
  senderDeviceId: string;
  expectedSenderIdentityKeyB64?: string;
}): Promise<string | null> {
  const parsed = parseRepeatablePreKeyEnvelope(args.payload);
  if (!parsed) return null;

  const myKeys = await getOrCreateIdentityKeys(args.recipientUserId);
  const myIdentityKeyB64 = await exportIdentityKeyB64(myKeys.publicKey);
  if (parsed.recipientIdentityKeyB64 !== myIdentityKeyB64) {
    throw new Error('X3DH_RECIPIENT_IDENTITY_MISMATCH');
  }
  if (
    args.expectedSenderIdentityKeyB64 &&
    parsed.senderIdentityKeyB64 !== args.expectedSenderIdentityKeyB64
  ) {
    throw new Error('X3DH_SENDER_IDENTITY_MISMATCH');
  }

  const key = pairKey(args.recipientUserId, args.recipientDeviceId, args.senderUserId, args.senderDeviceId);
  const existing = await readSession(key);
  if (existing?.sessionId === parsed.sessionId) {
    const plaintext = await ratchetDecryptWithSession(
      args.recipientUserId,
      args.recipientDeviceId,
      args.senderUserId,
      args.senderDeviceId,
      parsed.innerRatchet,
    );
    if (plaintext !== null) await deleteInitiating(key).catch(() => undefined);
    return plaintext;
  }

  const before = await snapshotPair(key);
  let replayReservation: unknown;
  try {
    const runtime = await import('@/lib/crypto/x3dh');
    const response = await runtime.x3dhRespondForDevice(myKeys, args.recipientUserId, args.recipientDeviceId, {
      ik: parsed.senderIdentityKeyB64,
      ek: parsed.ekB64,
      spkId: parsed.spkId,
      opkId: parsed.opkId,
    }) as any;
    replayReservation = response.replayReservation;

    const macKeyB64 = await deriveMacKeyB64(response.sharedSecret);
    const tagValid = await verifyEnvelopeTag(
      parsed,
      macKeyB64,
      args.senderUserId,
      args.senderDeviceId,
      args.recipientUserId,
      args.recipientDeviceId,
    );
    if (!tagValid) throw new Error('X3DH_REPEATABLE_ENVELOPE_TAG_INVALID');

    const spkPrivJwk = await hardCrypto.exportKey('jwk', response.spkKeyPair.privateKey);
    const spkPubRaw = await hardCrypto.exportKey('raw', response.spkKeyPair.publicKey);
    await establishDeviceSession(
      args.recipientUserId,
      args.recipientDeviceId,
      args.senderUserId,
      args.senderDeviceId,
      response.sharedSecret,
      parsed.sessionId,
      {
        isInitiator: false,
        peerSpkId: parsed.spkId,
        selfInitialDhPrivJwk: spkPrivJwk,
        selfInitialDhPubB64: bufferToBase64(spkPubRaw as ArrayBuffer),
      },
    );

    const plaintext = await ratchetDecryptWithSession(
      args.recipientUserId,
      args.recipientDeviceId,
      args.senderUserId,
      args.senderDeviceId,
      parsed.innerRatchet,
    );
    if (plaintext === null) throw new Error('X3DH_REPEATABLE_INNER_RATCHET_DECRYPT_FAILED');

    const finalize = (runtime as any).finalizeDeviceX3DHInitial;
    if (typeof finalize !== 'function') throw new Error('X3DH_TWO_PHASE_FINALIZER_MISSING');
    await finalize({
      userId: args.recipientUserId,
      deviceId: args.recipientDeviceId,
      replayReservation: response.replayReservation,
      usedOpkId: response.usedOpkId,
    });
    await deleteInitiating(key).catch(() => undefined);
    return plaintext;
  } catch (error) {
    await restorePair(key, before).catch(() => undefined);
    if (replayReservation) {
      try {
        const runtime = await import('@/lib/crypto/x3dh');
        const cancel = (runtime as any).cancelDeviceX3DHInitial;
        if (typeof cancel === 'function') await cancel(replayReservation);
      } catch {}
    }
    throw error;
  }
}

export async function acknowledgeInitiatingSessionFromRatchetPayload(args: {
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
  ratchetPayload: string;
}): Promise<void> {
  if (!parseRatchetSessionId(args.ratchetPayload)) return;
  await clearInitiatingSessionForPair(args);
}

export async function restartExpiredInitiatingSession(args: {
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
}): Promise<void> {
  await clearInitiatingSessionForPair(args).catch(() => undefined);
  await invalidateDeviceSession(args.myUserId, args.myDeviceId, args.peerUserId, args.peerDeviceId);
}

export const __test__ = {
  prefix: PREFIX,
  parseRepeatablePreKeyEnvelope,
  parseRatchetSessionId,
  canonicalMacPayload,
  maxInitiatingMessages: MAX_INITIATING_MESSAGES,
  initiatingTtlMs: INITIATING_TTL_MS,
};
