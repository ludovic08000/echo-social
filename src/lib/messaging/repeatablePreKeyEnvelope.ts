import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import {
  readDeviceSessionRecord,
  removeDeviceSessionRecord,
  writeDeviceSessionRecord,
} from '@/lib/crypto/deviceSessionStore';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import {
  establishDeviceSession,
  invalidateDeviceSession,
  ratchetDecryptWithSession,
  ratchetEncrypt,
} from '@/lib/crypto/deviceRatchet';
import {
  AEGIS_INIT_PREFIX,
  parseAegisInitialPayload,
  parseAegisRatchetPayload,
} from '@/lib/crypto/aegisDeviceWire';
import {
  fetchPrekeyBundleForDevice,
  x3dhInitiate,
} from '@/lib/crypto/x3dh';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';

const SESSION_STORE = 'sessions';
const INITIATING_STORE = 'initiating-sessions';
const PREFIX = AEGIS_INIT_PREFIX;
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
  return parseAegisRatchetPayload(payload)?.sessionId ?? null;
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
  return parseAegisInitialPayload(payload) !== null;
}

export function parseRepeatablePreKeyEnvelope(payload: string): ParsedRepeatablePreKeyEnvelope | null {
  const parsed = parseAegisInitialPayload(payload);
  if (!parsed) return null;
  return {
    sessionId: parsed.sessionId,
    ekB64: parsed.ephemeralKeyB64,
    spkId: parsed.signedPrekeyId,
    opkId: parsed.oneTimePrekeyId,
    senderIdentityKeyB64: parsed.senderIdentityKeyB64,
    recipientIdentityKeyB64: parsed.recipientIdentityKeyB64,
    innerRatchet: parsed.innerRatchet,
    tagB64: parsed.tagB64,
  };
}

async function readSession(key: string): Promise<StoredSessionRecord | null> {
  return readDeviceSessionRecord<StoredSessionRecord>(SESSION_STORE, key);
}

async function readInitiating(key: string): Promise<InitiatingEnvelopeRecord | null> {
  return readDeviceSessionRecord<InitiatingEnvelopeRecord>(INITIATING_STORE, key);
}

async function writeInitiating(record: InitiatingEnvelopeRecord): Promise<void> {
  await writeDeviceSessionRecord(INITIATING_STORE, record);
}

async function deleteInitiating(key: string): Promise<void> {
  await removeDeviceSessionRecord(INITIATING_STORE, key);
}

async function snapshotPair(key: string): Promise<PairSnapshot> {
  const [session, initiating] = await Promise.all([readSession(key), readInitiating(key)]);
  return {
    session: session ? structuredClone(session) : null,
    initiating: initiating ? structuredClone(initiating) : null,
  };
}

async function restorePair(key: string, snapshot: PairSnapshot): Promise<void> {
  await Promise.all([
    snapshot.session
      ? writeDeviceSessionRecord(SESSION_STORE, structuredClone(snapshot.session))
      : removeDeviceSessionRecord(SESSION_STORE, key),
    snapshot.initiating
      ? writeDeviceSessionRecord(INITIATING_STORE, structuredClone(snapshot.initiating))
      : removeDeviceSessionRecord(INITIATING_STORE, key),
  ]);
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
  conversationId?: string;
  useOneTimePrekey?: boolean;
}): Promise<string | null> {
  const key = pairKey(args.senderUserId, args.senderDeviceId, args.recipientUserId, args.recipientDeviceId);
  const before = await snapshotPair(key);
  try {
    const bundle = await fetchPrekeyBundleForDevice(args.recipientUserId, args.recipientDeviceId, {
      claimOneTimePrekey: args.useOneTimePrekey !== false,
      conversationId: args.conversationId,
      senderDeviceId: args.senderDeviceId,
    });
    if (!bundle) return null;

    const myKeys = await getOrCreateDeviceKxKey(args.senderDeviceId, args.senderUserId);
    const senderIdentityKeyB64 = myKeys.publicB64;
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
        selfIkPubB64: senderIdentityKeyB64,
        peerIkPubB64: bundle.identityKey,
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

  const myKeys = await getOrCreateDeviceKxKey(args.recipientDeviceId, args.recipientUserId);
  const myIdentityKeyB64 = myKeys.publicB64;
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
        selfIkPubB64: myIdentityKeyB64,
        peerIkPubB64: parsed.senderIdentityKeyB64,
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
