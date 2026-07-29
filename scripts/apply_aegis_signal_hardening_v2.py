from __future__ import annotations

from pathlib import Path
import re

ROOT = Path.cwd()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.strip() + "\n", encoding="utf-8")


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = ROOT / path
    source = target.read_text(encoding="utf-8-sig")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 occurrence, found {count}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


def regex_once(path: str, pattern: str, replacement: str, label: str, flags: int = re.S) -> None:
    target = ROOT / path
    source = target.read_text(encoding="utf-8-sig")
    updated, count = re.subn(pattern, replacement, source, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 regex occurrence, found {count}")
    target.write_text(updated, encoding="utf-8")


write("src/lib/messaging/aegisWire.ts", r'''
import { base64ToBuffer, bufferToBase64, randomBytes } from '@/lib/crypto/utils';

export const AEGIS_RATCHET_PREFIX = 'aegis1.ratchet.';
export const AEGIS_INIT_PREFIX = 'aegis1.init.v1.';

export const AEGIS_MAX_DEVICE_COPY_BYTES = 128 * 1024;
export const AEGIS_MAX_RATCHET_CIPHERTEXT_BYTES = 64 * 1024;
export const AEGIS_MAX_RATCHET_COUNTER = 10_000_000;

const LEGACY_HEADER_BOUND_SESSION_RE = /^s6[A-Za-z0-9]{8,10}$/;
const CURRENT_SESSION_RE = /^s7[A-Za-z0-9_-]{22}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,9})$/;
const POSITIVE_DECIMAL_RE = /^[1-9][0-9]{0,9}$/;

export interface ParsedAegisRatchetWire {
  sessionId: string;
  dhPubB64: string;
  n: number;
  pn: number;
  ivB64: string;
  ciphertextB64: string;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

export interface ParsedAegisInitWire {
  sessionId: string;
  ekB64: string;
  spkId: number;
  opkId?: number;
  senderIdentityKeyB64: string;
  recipientIdentityKeyB64: string;
  innerRatchet: string;
  tagB64: string;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeBase64Within(
  value: string,
  minBytes: number,
  maxBytes: number,
): ArrayBuffer | null {
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 + 4) return null;
  try {
    const decoded = base64ToBuffer(value);
    return decoded.byteLength >= minBytes && decoded.byteLength <= maxBytes ? decoded : null;
  } catch {
    return null;
  }
}

function parseCounter(value: string, positive = false): number | null {
  if (!(positive ? POSITIVE_DECIMAL_RE : DECIMAL_RE).test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (positive ? 1 : 0)) return null;
  if (parsed > AEGIS_MAX_RATCHET_COUNTER) return null;
  return parsed;
}

export function createAegisSessionId(): string {
  const raw = randomBytes(16);
  return `s7${bufferToBase64(raw.buffer as ArrayBuffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')}`;
}

/** s6 is retained only because it already authenticates its header. */
export function isHeaderBoundAegisSessionId(value: string): boolean {
  return LEGACY_HEADER_BOUND_SESSION_RE.test(value) || CURRENT_SESSION_RE.test(value);
}

export function parseAegisRatchetWire(
  payload: string | null | undefined,
): ParsedAegisRatchetWire | null {
  if (!payload || !payload.startsWith(AEGIS_RATCHET_PREFIX)) return null;
  if (utf8Length(payload) > AEGIS_MAX_DEVICE_COPY_BYTES) return null;

  const parts = payload.slice(AEGIS_RATCHET_PREFIX.length).split('.');
  if (parts.length !== 6) return null;
  const [sessionId, dhPubB64, nRaw, pnRaw, ivB64, ciphertextB64] = parts;
  if (!isHeaderBoundAegisSessionId(sessionId)) return null;

  const n = parseCounter(nRaw);
  const pn = parseCounter(pnRaw);
  const dhPub = decodeBase64Within(dhPubB64, 32, 32);
  const ivBuffer = decodeBase64Within(ivB64, 12, 12);
  const ciphertext = decodeBase64Within(
    ciphertextB64,
    16,
    AEGIS_MAX_RATCHET_CIPHERTEXT_BYTES,
  );
  if (n === null || pn === null || !dhPub || !ivBuffer || !ciphertext) return null;

  return {
    sessionId,
    dhPubB64,
    n,
    pn,
    ivB64,
    ciphertextB64,
    iv: new Uint8Array(ivBuffer),
    ciphertext,
  };
}

export function parseAegisInitWire(
  payload: string | null | undefined,
): ParsedAegisInitWire | null {
  if (!payload || !payload.startsWith(AEGIS_INIT_PREFIX)) return null;
  if (utf8Length(payload) > AEGIS_MAX_DEVICE_COPY_BYTES) return null;

  const parts = payload.slice(AEGIS_INIT_PREFIX.length).split('.');
  if (parts.length !== 8) return null;
  const [
    sessionId,
    ekB64,
    spkRaw,
    opkRaw,
    senderIdentityKeyB64,
    recipientIdentityKeyB64,
    innerB64,
    tagB64,
  ] = parts;
  if (!isHeaderBoundAegisSessionId(sessionId)) return null;

  const spkId = parseCounter(spkRaw, true);
  const opkId = opkRaw === '0' ? undefined : parseCounter(opkRaw, true);
  if (spkId === null || (opkRaw !== '0' && opkId === null)) return null;
  if (!decodeBase64Within(ekB64, 32, 32)) return null;
  if (!decodeBase64Within(senderIdentityKeyB64, 32, 32)) return null;
  if (!decodeBase64Within(recipientIdentityKeyB64, 32, 32)) return null;
  if (!decodeBase64Within(tagB64, 32, 32)) return null;

  const innerBytes = decodeBase64Within(
    innerB64,
    AEGIS_RATCHET_PREFIX.length + 1,
    AEGIS_MAX_DEVICE_COPY_BYTES,
  );
  if (!innerBytes) return null;

  let innerRatchet: string;
  try {
    innerRatchet = new TextDecoder('utf-8', { fatal: true }).decode(innerBytes);
  } catch {
    return null;
  }
  const parsedInner = parseAegisRatchetWire(innerRatchet);
  if (!parsedInner || parsedInner.sessionId !== sessionId) return null;

  return {
    sessionId,
    ekB64,
    spkId,
    opkId: opkId ?? undefined,
    senderIdentityKeyB64,
    recipientIdentityKeyB64,
    innerRatchet,
    tagB64,
  };
}

export function isAegisDeviceCopyWireStrict(
  payload: string | null | undefined,
): payload is string {
  return parseAegisRatchetWire(payload) !== null || parseAegisInitWire(payload) !== null;
}
''')

# Double Ratchet: strict parser, 128-bit session IDs, no unauthenticated header fallback.
replace_once(
    "src/lib/crypto/deviceRatchet.ts",
    "import { traceE2EE } from '@/lib/messaging/e2eeTrace';\n",
    "import { traceE2EE } from '@/lib/messaging/e2eeTrace';\nimport {\n  AEGIS_RATCHET_PREFIX,\n  createAegisSessionId,\n  isHeaderBoundAegisSessionId,\n  parseAegisRatchetWire,\n  type ParsedAegisRatchetWire,\n} from '@/lib/messaging/aegisWire';\n",
    "deviceRatchet wire import",
)
replace_once(
    "src/lib/crypto/deviceRatchet.ts",
    "export const AEGIS_RATCHET_PREFIX = 'aegis1.ratchet.';\n\nconst AEGIS_DEVICE_AAD = 'FORSURE-AEGIS-DEVICE-v1|';\nconst AEGIS_HEADER_AAD = 'FORSURE-AEGIS-HEADER-v1|';\nconst HEADER_BOUND_SESSION_PREFIX = 's6';\n",
    "export { AEGIS_RATCHET_PREFIX };\n\nconst AEGIS_DEVICE_AAD = 'FORSURE-AEGIS-DEVICE-v1|';\nconst AEGIS_HEADER_AAD = 'FORSURE-AEGIS-HEADER-v1|';\n",
    "deviceRatchet constants",
)
replace_once(
    "src/lib/crypto/deviceRatchet.ts",
    "function isHeaderBoundSession(sessionId: string): boolean {\n  return sessionId.startsWith(HEADER_BOUND_SESSION_PREFIX);\n}\n\n",
    "",
    "deviceRatchet legacy header helper",
)
replace_once(
    "src/lib/crypto/deviceRatchet.ts",
    "  const finalSessionId =\n    sessionId ?? `${HEADER_BOUND_SESSION_PREFIX}${bufferToBase64(randomBytes(8).buffer as ArrayBuffer).replace(/[+/=]/g, '').slice(0, 10)}`;\n",
    "  const finalSessionId = sessionId ?? createAegisSessionId();\n  if (!isHeaderBoundAegisSessionId(finalSessionId)) {\n    throw new Error('AEGIS_UNSUPPORTED_SESSION_ID');\n  }\n",
    "deviceRatchet session id",
)
replace_once(
    "src/lib/crypto/deviceRatchet.ts",
    "  if (!session.ckSendB64 || !session.dhsPubB64) {\n",
    "  if (!isHeaderBoundAegisSessionId(session.sessionId)) {\n    return null;\n  }\n\n  if (!session.ckSendB64 || !session.dhsPubB64) {\n",
    "deviceRatchet active session gate",
)
replace_once(
    "src/lib/crypto/deviceRatchet.ts",
    "  const aad = isHeaderBoundSession(session.sessionId)\n    ? buildDevAADWithHeader(myUserId, myDeviceId, peerUserId, peerDeviceId, session.sessionId, header)\n    : buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, session.sessionId);\n",
    "  const aad = buildDevAADWithHeader(\n    myUserId,\n    myDeviceId,\n    peerUserId,\n    peerDeviceId,\n    session.sessionId,\n    header,\n  );\n",
    "deviceRatchet encrypt AAD",
)
regex_once(
    "src/lib/crypto/deviceRatchet.ts",
    r"export async function ratchetDecrypt\(.*?\nexport async function ratchetDecryptWithSession\(",
    r'''export async function ratchetDecrypt(
  myUserId: string,
  myDeviceId: string,
  payload: string,
): Promise<string | null> {
  const parsed = parseAegisRatchetWire(payload);
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
  parsed: ParsedAegisRatchetWire,
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
  const parsed = parseAegisRatchetWire(payload);
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
  return decryptAegisWithStored(
    key,
    found.key,
    found.session,
    parsed,
    aad,
    { peerUserId, peerDeviceId },
  );
}

export async function ratchetDecryptWithSession(''',
    "deviceRatchet decrypt entrypoints",
)
regex_once(
    "src/lib/crypto/deviceRatchet.ts",
    r"async function decryptAegisWithStored\(\n  activeKey: string,\n  storageKey: string,\n  initialSession: StoredSession,\n  parts: string\[],\n  aad: Uint8Array,\n  logContext: DecryptLogContext = \{},\n\): Promise<string \| null> \{\n  const \[sessionId, dhPubB64, NsStr, PNStr, ivB64, ctB64\] = parts;\n  const Ns = parseInt\(NsStr, 10\);\n  const PN = parseInt\(PNStr, 10\);\n  if \(Number\.isNaN\(Ns\) \|\| Number\.isNaN\(PN\)\) return null;\n\n  let session = pruneExpiredSkippedKeys\(initialSession\);\n  const iv = new Uint8Array\(base64ToBuffer\(ivB64\)\);\n  const ct = base64ToBuffer\(ctB64\);",
    r'''async function decryptAegisWithStored(
  activeKey: string,
  storageKey: string,
  initialSession: StoredSession,
  parsed: ParsedAegisRatchetWire,
  aad: Uint8Array,
  logContext: DecryptLogContext = {},
): Promise<string | null> {
  const {
    sessionId,
    dhPubB64,
    n: Ns,
    pn: PN,
    iv,
    ciphertext: ct,
  } = parsed;

  let session = pruneExpiredSkippedKeys(initialSession);''',
    "deviceRatchet strict decoded payload",
)

# Repeated X3DH init envelope uses the same bounded wire parser.
replace_once(
    "src/lib/messaging/repeatablePreKeyEnvelope.ts",
    "import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';\n",
    "import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';\nimport {\n  AEGIS_INIT_PREFIX,\n  parseAegisInitWire,\n  parseAegisRatchetWire,\n} from '@/lib/messaging/aegisWire';\n",
    "repeatable wire imports",
)
replace_once(
    "src/lib/messaging/repeatablePreKeyEnvelope.ts",
    "const PREFIX = 'aegis1.init.v1.';\n",
    "const PREFIX = AEGIS_INIT_PREFIX;\n",
    "repeatable prefix",
)
replace_once(
    "src/lib/messaging/repeatablePreKeyEnvelope.ts",
    "function parseRatchetSessionId(payload: string): string | null {\n  if (!payload.startsWith(AEGIS_RATCHET_PREFIX)) return null;\n  const parts = payload.slice(AEGIS_RATCHET_PREFIX.length).split('.');\n  if (parts.length !== 6 || !parts[0]) return null;\n  return parts[0];\n}\n",
    "function parseRatchetSessionId(payload: string): string | null {\n  return parseAegisRatchetWire(payload)?.sessionId ?? null;\n}\n",
    "repeatable ratchet id parser",
)
replace_once(
    "src/lib/messaging/repeatablePreKeyEnvelope.ts",
    "function base64ToUtf8(value: string): string {\n  return new hardGlobals.TextDecoder().decode(base64ToBuffer(value));\n}\n\n",
    "",
    "repeatable old UTF8 parser",
)
regex_once(
    "src/lib/messaging/repeatablePreKeyEnvelope.ts",
    r"export function isRepeatablePreKeyEnvelope\(payload: string\): boolean \{.*?\n\}\n\nexport function parseRepeatablePreKeyEnvelope\(payload: string\): ParsedRepeatablePreKeyEnvelope \| null \{.*?\n\}\n\nasync function readSession",
    r'''export function isRepeatablePreKeyEnvelope(payload: string): boolean {
  return parseAegisInitWire(payload) !== null;
}

export function parseRepeatablePreKeyEnvelope(payload: string): ParsedRepeatablePreKeyEnvelope | null {
  const parsed = parseAegisInitWire(payload);
  if (!parsed) return null;
  return parsed;
}

async function readSession''',
    "repeatable strict parser",
)

# Prefix-only validation is removed from compatibility and the send path.
replace_once(
    "src/lib/messaging/messageCompatibility.ts",
    "} from '@/lib/messaging/aegisEnvelope';\n",
    "} from '@/lib/messaging/aegisEnvelope';\nimport {\n  AEGIS_INIT_PREFIX,\n  AEGIS_RATCHET_PREFIX,\n  isAegisDeviceCopyWireStrict,\n} from '@/lib/messaging/aegisWire';\n",
    "compatibility strict import",
)
replace_once(
    "src/lib/messaging/messageCompatibility.ts",
    "export const AEGIS_DEVICE_COPY_RATCHET_PREFIX = 'aegis1.ratchet.';\nexport const AEGIS_DEVICE_COPY_INIT_PREFIX = 'aegis1.init.v1.';\n",
    "export const AEGIS_DEVICE_COPY_RATCHET_PREFIX = AEGIS_RATCHET_PREFIX;\nexport const AEGIS_DEVICE_COPY_INIT_PREFIX = AEGIS_INIT_PREFIX;\n",
    "compatibility prefixes",
)
replace_once(
    "src/lib/messaging/messageCompatibility.ts",
    "export function isAegisDeviceCopyWire(body: string | null | undefined): body is string {\n  return typeof body === 'string' && (\n    body.startsWith(AEGIS_DEVICE_COPY_RATCHET_PREFIX) ||\n    body.startsWith(AEGIS_DEVICE_COPY_INIT_PREFIX)\n  );\n}\n",
    "export function isAegisDeviceCopyWire(body: string | null | undefined): body is string {\n  return isAegisDeviceCopyWireStrict(body);\n}\n",
    "compatibility exact wire",
)

# Parent envelope parsing is bounded before JSON/base64 allocation.
replace_once(
    "src/lib/messaging/aegisEnvelope.ts",
    "const AAD_PREFIX = 'FORSURE-AEGIS-MESSAGE-v1|';\n",
    "const AAD_PREFIX = 'FORSURE-AEGIS-MESSAGE-v1|';\nconst MAX_PARENT_BODY_BYTES = 512 * 1024;\nconst MAX_PARENT_CIPHERTEXT_BYTES = 256 * 1024;\nconst MAX_KEY_CAPSULE_BYTES = 8 * 1024;\nconst UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;\n\nfunction utf8Length(value: string): number {\n  return new hardGlobals.TextEncoder().encode(value).byteLength;\n}\n\nfunction base64LengthBetween(value: string, min: number, max: number): boolean {\n  if (!value || value.length > Math.ceil(max / 3) * 4 + 4) return false;\n  try {\n    const length = base64ToBuffer(value).byteLength;\n    return length >= min && length <= max;\n  } catch {\n    return false;\n  }\n}\n",
    "envelope bounds helpers",
)
regex_once(
    "src/lib/messaging/aegisEnvelope.ts",
    r"export function parseAegisMessageEnvelope\(\n  body: string \| null \| undefined,\n\): AegisMessageEnvelope \| null \{.*?\n\}\n\nexport function parseAegisKeyCapsule",
    r'''export function parseAegisMessageEnvelope(
  body: string | null | undefined,
): AegisMessageEnvelope | null {
  if (!body || !body.startsWith('{') || utf8Length(body) > MAX_PARENT_BODY_BYTES) return null;
  try {
    const parsed = hardGlobals.jsonParse(body) as Partial<AegisMessageEnvelope>;
    if (
      parsed.protocol !== AEGIS_MESSAGE_PROTOCOL ||
      parsed.version !== AEGIS_WIRE_VERSION ||
      parsed.encryptionMode !== 'multi_device' ||
      parsed.algorithm !== 'AES-256-GCM' ||
      parsed.keyTransport !== 'device_ratchet' ||
      !isNonEmptyString(parsed.messageId) || !UUID_RE.test(parsed.messageId) ||
      !isNonEmptyString(parsed.conversationId) || !UUID_RE.test(parsed.conversationId) ||
      !isNonEmptyString(parsed.senderId) || !UUID_RE.test(parsed.senderId) ||
      !isNonEmptyString(parsed.iv) || !base64LengthBetween(parsed.iv, IV_BYTES, IV_BYTES) ||
      !isNonEmptyString(parsed.ciphertext) ||
      !base64LengthBetween(parsed.ciphertext, 16, MAX_PARENT_CIPHERTEXT_BYTES) ||
      !isNonEmptyString(parsed.digest) || !base64LengthBetween(parsed.digest, 32, 32) ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt) ||
      parsed.createdAt <= 0
    ) {
      return null;
    }
    return parsed as AegisMessageEnvelope;
  } catch {
    return null;
  }
}

export function parseAegisKeyCapsule''',
    "strict parent envelope parser",
)
regex_once(
    "src/lib/messaging/aegisEnvelope.ts",
    r"export function parseAegisKeyCapsule\(value: string \| null \| undefined\): AegisKeyCapsule \| null \{.*?\n\}\n\nexport async function createAegisMessage",
    r'''export function parseAegisKeyCapsule(value: string | null | undefined): AegisKeyCapsule | null {
  if (!value || !value.startsWith('{') || utf8Length(value) > MAX_KEY_CAPSULE_BYTES) return null;
  try {
    const parsed = hardGlobals.jsonParse(value) as Partial<AegisKeyCapsule>;
    if (
      parsed.protocol !== AEGIS_KEY_PROTOCOL ||
      parsed.version !== AEGIS_WIRE_VERSION ||
      !isNonEmptyString(parsed.messageId) || !UUID_RE.test(parsed.messageId) ||
      !isNonEmptyString(parsed.conversationId) || !UUID_RE.test(parsed.conversationId) ||
      !isNonEmptyString(parsed.senderId) || !UUID_RE.test(parsed.senderId) ||
      !isNonEmptyString(parsed.contentKey) ||
      !base64LengthBetween(parsed.contentKey, CONTENT_KEY_BYTES, CONTENT_KEY_BYTES) ||
      !isNonEmptyString(parsed.digest) || !base64LengthBetween(parsed.digest, 32, 32)
    ) {
      return null;
    }
    return parsed as AegisKeyCapsule;
  } catch {
    return null;
  }
}

export async function createAegisMessage''',
    "strict key capsule parser",
)

# Device v2: per-device signing key remains local, but the account signing key authorizes it.
write("src/lib/crypto/deviceIdentity.ts", r'''
import { SIG_KEY_PARAMS, STORE_KEYS } from './constants';
import { hardCrypto } from './cryptoIntegrity';
import { runTx, reqToPromise } from './indexedDbTx';
import {
  base64ToBuffer,
  bufferToBase64,
  encodeString,
  exportKeyToJWK,
  importKeyFromJWK,
} from './utils';

export const LEGACY_DEVICE_IDENTITY_VERSION = 1;
export const ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION = 2;

export interface DeviceIdentityKey {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicB64: string;
}

interface StoredDeviceIdentity {
  id: string;
  userId: string;
  deviceId: string;
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  createdAt: number;
}

const creationJobs = new Map<string, Promise<DeviceIdentityKey>>();

function storageKey(userId: string, deviceId: string): string {
  return `device-signing::${userId}::${deviceId}`;
}

function dbGet<T>(key: string): Promise<T | undefined> {
  return runTx([STORE_KEYS], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_KEYS).get(key) as IDBRequest<T | undefined>),
  );
}

function dbPut<T>(value: T): Promise<void> {
  return runTx([STORE_KEYS], 'readwrite', (tx) => {
    tx.objectStore(STORE_KEYS).put(value as unknown as object);
  });
}

async function publicKeyToBase64(publicKey: CryptoKey): Promise<string> {
  try {
    return bufferToBase64(await hardCrypto.exportKey('raw', publicKey) as ArrayBuffer);
  } catch {
    const jwk = await hardCrypto.exportKey('jwk', publicKey) as JsonWebKey;
    if (!jwk.x) throw new Error('DEVICE_IDENTITY_PUBLIC_EXPORT_FAILED');
    const value = jwk.x.replace(/-/g, '+').replace(/_/g, '/');
    return value + '='.repeat((4 - value.length % 4) % 4);
  }
}

export function canonicalDeviceIdentityPayload(args: {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  signingPublicKey: string;
  identityVersion?: number;
}): string {
  const version = args.identityVersion ?? LEGACY_DEVICE_IDENTITY_VERSION;
  return JSON.stringify({
    protocol: 'forsure-sesame-device',
    version,
    userId: args.userId,
    deviceId: args.deviceId,
    devicePublicKey: args.devicePublicKey,
    signingPublicKey: args.signingPublicKey,
  });
}

export async function loadDeviceIdentity(
  userId: string,
  deviceId: string,
): Promise<DeviceIdentityKey | null> {
  const stored = await dbGet<StoredDeviceIdentity>(storageKey(userId, deviceId));
  if (!stored) return null;
  const [publicKey, privateKey] = await Promise.all([
    importKeyFromJWK(stored.publicKeyJWK, SIG_KEY_PARAMS, ['verify'], true),
    importKeyFromJWK(stored.privateKeyJWK, SIG_KEY_PARAMS, ['sign'], false),
  ]);
  return { publicKey, privateKey, publicB64: await publicKeyToBase64(publicKey) };
}

export async function getOrCreateDeviceIdentity(
  userId: string,
  deviceId: string,
): Promise<DeviceIdentityKey> {
  const id = storageKey(userId, deviceId);
  const pending = creationJobs.get(id);
  if (pending) return pending;
  const job = createDeviceIdentityUnderLock(userId, deviceId, id).finally(() => {
    if (creationJobs.get(id) === job) creationJobs.delete(id);
  });
  creationJobs.set(id, job);
  return job;
}

async function createDeviceIdentityUnderLock(
  userId: string,
  deviceId: string,
  id: string,
): Promise<DeviceIdentityKey> {
  const create = async (): Promise<DeviceIdentityKey> => {
    const existing = await loadDeviceIdentity(userId, deviceId);
    if (existing) return existing;
    const generated = await hardCrypto.generateKey(
      SIG_KEY_PARAMS,
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const [publicKeyJWK, privateKeyJWK, publicB64] = await Promise.all([
      exportKeyToJWK(generated.publicKey),
      exportKeyToJWK(generated.privateKey),
      publicKeyToBase64(generated.publicKey),
    ]);
    await dbPut<StoredDeviceIdentity>({
      id,
      userId,
      deviceId,
      publicKeyJWK,
      privateKeyJWK,
      createdAt: Date.now(),
    });
    const privateKey = await importKeyFromJWK(
      privateKeyJWK,
      SIG_KEY_PARAMS,
      ['sign'],
      false,
    );
    return { publicKey: generated.publicKey, privateKey, publicB64 };
  };

  if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
    return navigator.locks.request(`forsure:device-identity:${id}`, { mode: 'exclusive' }, create);
  }
  return create();
}

/**
 * Version 2 is signed by the account Ed25519 key. The optional legacy branch is
 * retained only for parsing/tests while v1 rows are migrated; secure routes use v2.
 */
export async function signDeviceIdentityBinding(args: {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  identity: DeviceIdentityKey;
  accountSigningPrivateKey?: CryptoKey;
  identityVersion?: number;
}): Promise<string> {
  const identityVersion = args.identityVersion ?? (
    args.accountSigningPrivateKey
      ? ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION
      : LEGACY_DEVICE_IDENTITY_VERSION
  );
  const payload = canonicalDeviceIdentityPayload({
    userId: args.userId,
    deviceId: args.deviceId,
    devicePublicKey: args.devicePublicKey,
    signingPublicKey: args.identity.publicB64,
    identityVersion,
  });
  const signer = identityVersion === ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION
    ? args.accountSigningPrivateKey
    : args.identity.privateKey;
  if (!signer) throw new Error('ACCOUNT_SIGNING_KEY_REQUIRED_FOR_DEVICE_V2');
  return bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    signer,
    encodeString(payload),
  ) as ArrayBuffer);
}

export async function verifyDeviceIdentityBinding(args: {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  signingPublicKey: string;
  signature: string;
  identityVersion?: number;
  accountSigningPublicKey?: string;
}): Promise<boolean> {
  const identityVersion = args.identityVersion ?? LEGACY_DEVICE_IDENTITY_VERSION;
  if (
    identityVersion !== LEGACY_DEVICE_IDENTITY_VERSION &&
    identityVersion !== ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION
  ) return false;
  if (
    identityVersion === ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION &&
    !args.accountSigningPublicKey
  ) return false;

  try {
    const verifierB64 = identityVersion === ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION
      ? args.accountSigningPublicKey!
      : args.signingPublicKey;
    const publicKey = await hardCrypto.importKey(
      'raw',
      base64ToBuffer(verifierB64),
      { name: 'Ed25519' } as Algorithm,
      false,
      ['verify'],
    );
    return await hardCrypto.verify(
      'Ed25519',
      publicKey,
      base64ToBuffer(args.signature),
      encodeString(canonicalDeviceIdentityPayload({ ...args, identityVersion })),
    );
  } catch {
    return false;
  }
}
''')

write("src/lib/crypto/signedDeviceList.ts", r'''
import { supabase } from '@/integrations/supabase/client';
import {
  ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
  verifyDeviceIdentityBinding,
} from './deviceIdentity';
import { fetchPeerPublicKeys } from './peerKeyCache';

export interface SignedDeviceEntry {
  deviceId: string;
  devicePublicKey: string;
  deviceSigningKey: string;
  identitySignature: string;
  identityVersion: number;
  lastSeenAt: string | null;
}

export interface DeviceVerificationResult {
  deviceId: string;
  ok: boolean;
  reason?:
    | 'VALID'
    | 'NO_ACCOUNT_IDENTITY'
    | 'NO_IDENTITY'
    | 'UNSUPPORTED_IDENTITY_VERSION'
    | 'BAD_DEVICE_IDENTITY_SIGNATURE';
}

type SesameDeviceRow = {
  device_id: string;
  device_public_key: string;
  device_signing_key: string;
  device_identity_signature: string;
  device_identity_version: number;
  last_seen_at: string | null;
};

export async function fetchSignedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  if (!userId) return [];
  const { data, error } = await (supabase as any).rpc('get_sesame_device_list', {
    p_user_id: userId,
  });
  if (error) throw error;
  return ((data ?? []) as unknown as SesameDeviceRow[]).map((row) => ({
    deviceId: row.device_id,
    devicePublicKey: row.device_public_key,
    deviceSigningKey: row.device_signing_key,
    identitySignature: row.device_identity_signature,
    identityVersion: Number(row.device_identity_version ?? 0),
    lastSeenAt: row.last_seen_at ?? null,
  }));
}

export async function verifySignedDeviceList(
  userId: string,
  list: SignedDeviceEntry[],
): Promise<DeviceVerificationResult[]> {
  const accountIdentity = await fetchPeerPublicKeys(userId, { forceRefresh: true });
  if (!accountIdentity?.signing_key) {
    return list.map((entry) => ({
      deviceId: entry.deviceId,
      ok: false,
      reason: 'NO_ACCOUNT_IDENTITY',
    }));
  }

  return Promise.all(list.map(async (entry): Promise<DeviceVerificationResult> => {
    if (!entry.devicePublicKey || !entry.deviceSigningKey || !entry.identitySignature) {
      return { deviceId: entry.deviceId, ok: false, reason: 'NO_IDENTITY' };
    }
    if (entry.identityVersion !== ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION) {
      return {
        deviceId: entry.deviceId,
        ok: false,
        reason: 'UNSUPPORTED_IDENTITY_VERSION',
      };
    }

    const ok = await verifyDeviceIdentityBinding({
      userId,
      deviceId: entry.deviceId,
      devicePublicKey: entry.devicePublicKey,
      signingPublicKey: entry.deviceSigningKey,
      signature: entry.identitySignature,
      identityVersion: entry.identityVersion,
      accountSigningPublicKey: accountIdentity.signing_key,
    });
    return {
      deviceId: entry.deviceId,
      ok,
      reason: ok ? 'VALID' : 'BAD_DEVICE_IDENTITY_SIGNATURE',
    };
  }));
}

export async function fetchTrustedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  const list = await fetchSignedDeviceList(userId);
  const verification = await verifySignedDeviceList(userId, list);
  const trustedIds = new Set(
    verification.filter((result) => result.ok).map((result) => result.deviceId),
  );
  return list.filter((entry) => trustedIds.has(entry.deviceId));
}

export async function fetchVerifiedDeviceList(userId: string): Promise<{
  signedListPresent: boolean;
  trusted: SignedDeviceEntry[];
  verifications: DeviceVerificationResult[];
}> {
  const list = await fetchSignedDeviceList(userId);
  const verifications = await verifySignedDeviceList(userId, list);
  const trustedIds = new Set(
    verifications.filter((result) => result.ok).map((result) => result.deviceId),
  );
  return {
    signedListPresent: list.length > 0,
    trusted: list.filter((entry) => trustedIds.has(entry.deviceId)),
    verifications,
  };
}

export const __test__ = { verifyDeviceIdentityBinding };
''')

replace_once(
    "src/hooks/useDeviceRegistration.ts",
    "import { PinUnlockRequiredError } from '@/lib/crypto/keyManager';\n",
    "import { getOrCreateIdentityKeys, PinUnlockRequiredError } from '@/lib/crypto/keyManager';\n",
    "registration account identity import",
)
replace_once(
    "src/hooks/useDeviceRegistration.ts",
    "  signDeviceIdentityBinding,\n} from '@/lib/crypto/deviceIdentity';\n",
    "  ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,\n  signDeviceIdentityBinding,\n} from '@/lib/crypto/deviceIdentity';\n",
    "registration v2 constant import",
)
replace_once(
    "src/hooks/useDeviceRegistration.ts",
    "        const deviceIdentity = await getOrCreateDeviceIdentity(user.id, deviceId);\n        trace('DEVICE_IDENTITY_READY');\n",
    "        const [deviceIdentity, accountIdentity] = await Promise.all([\n          getOrCreateDeviceIdentity(user.id, deviceId),\n          getOrCreateIdentityKeys(user.id),\n        ]);\n        trace('DEVICE_IDENTITY_READY');\n",
    "registration load account identity",
)
replace_once(
    "src/hooks/useDeviceRegistration.ts",
    "        const deviceIdentitySignature = await signDeviceIdentityBinding({\n          userId: user.id,\n          deviceId,\n          devicePublicKey: devicePublicKeyB64,\n          identity: deviceIdentity,\n        });\n",
    "        const deviceIdentitySignature = await signDeviceIdentityBinding({\n          userId: user.id,\n          deviceId,\n          devicePublicKey: devicePublicKeyB64,\n          identity: deviceIdentity,\n          accountSigningPrivateKey: accountIdentity.signingPrivateKey,\n          identityVersion: ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,\n        });\n",
    "registration account-authorized signature",
)
replace_once(
    "src/hooks/useDeviceRegistration.ts",
    "            p_device_identity_version: 1,\n",
    "            p_device_identity_version: ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,\n",
    "registration version 2 RPC",
)

# X3DH refuses a device row unless its device key is authorized by the account key.
replace_once(
    "src/lib/crypto/x3dh.ts",
    "  const { verifyDeviceIdentityBinding } = await import('./deviceIdentity');\n  const identityBindingValid = await verifyDeviceIdentityBinding({\n    userId: peerUserId,\n    deviceId: peerDeviceId,\n    devicePublicKey: device.device_public_key,\n    signingPublicKey: device.device_signing_key,\n    signature: device.device_identity_signature,\n  });\n",
    "  const [{ verifyDeviceIdentityBinding, ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION }, { fetchPeerPublicKeys }] = await Promise.all([\n    import('./deviceIdentity'),\n    import('./peerKeyCache'),\n  ]);\n  const accountIdentity = await fetchPeerPublicKeys(peerUserId, { forceRefresh: true });\n  const identityBindingValid =\n    device.device_identity_version === ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION &&\n    Boolean(accountIdentity?.signing_key) &&\n    await verifyDeviceIdentityBinding({\n      userId: peerUserId,\n      deviceId: peerDeviceId,\n      devicePublicKey: device.device_public_key,\n      signingPublicKey: device.device_signing_key,\n      signature: device.device_identity_signature,\n      identityVersion: device.device_identity_version,\n      accountSigningPublicKey: accountIdentity!.signing_key,\n    });\n",
    "x3dh account-authorized device",
)

# Incoming repeated-prekey copies receive the same account-root validation.
replace_once(
    "src/lib/messaging/multiDeviceFanout.ts",
    "      const { verifyDeviceIdentityBinding } = await import('@/lib/crypto/deviceIdentity');\n      if (\n        !senderDevice?.device_public_key ||\n        !senderDevice.device_signing_key ||\n        !senderDevice.device_identity_signature ||\n        !await verifyDeviceIdentityBinding({\n          userId: row.sender_user_id,\n          deviceId: row.sender_device_id,\n          devicePublicKey: senderDevice.device_public_key,\n          signingPublicKey: senderDevice.device_signing_key,\n          signature: senderDevice.device_identity_signature,\n        })\n      ) {\n",
    "      const [{ verifyDeviceIdentityBinding, ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION }, { fetchPeerPublicKeys }] = await Promise.all([\n        import('@/lib/crypto/deviceIdentity'),\n        import('@/lib/crypto/peerKeyCache'),\n      ]);\n      const accountIdentity = await fetchPeerPublicKeys(row.sender_user_id, { forceRefresh: true });\n      if (\n        !senderDevice?.device_public_key ||\n        !senderDevice.device_signing_key ||\n        !senderDevice.device_identity_signature ||\n        senderDevice.device_identity_version !== ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION ||\n        !accountIdentity?.signing_key ||\n        !await verifyDeviceIdentityBinding({\n          userId: row.sender_user_id,\n          deviceId: row.sender_device_id,\n          devicePublicKey: senderDevice.device_public_key,\n          signingPublicKey: senderDevice.device_signing_key,\n          signature: senderDevice.device_identity_signature,\n          identityVersion: senderDevice.device_identity_version,\n          accountSigningPublicKey: accountIdentity.signing_key,\n        })\n      ) {\n",
    "fanout incoming account authorization",
)

# Database cutover: v1 rows remain but are not eligible for secure routing.
write("supabase/migrations/20260729230000_aegis_account_authorized_device_identity.sql", r'''
begin;

alter table public.user_devices
  drop constraint if exists user_devices_device_identity_version_check;
alter table public.user_devices
  add constraint user_devices_device_identity_version_check
  check (device_identity_version in (1, 2));

create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table (
  device_id text,
  device_public_key text,
  device_signing_key text,
  device_identity_signature text,
  device_identity_version integer,
  last_seen_at timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    device.device_id,
    device.device_public_key,
    device.device_signing_key,
    device.device_identity_signature,
    device.device_identity_version,
    device.last_seen_at
  from public.user_devices device
  where device.user_id = p_user_id
    and device.is_active = true
    and coalesce(device.approval_status, 'approved') = 'approved'
    and device.revoked_at is null
    and device.routing_status = 'ready'
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_identity_signature), '') is not null
    and device.device_identity_version = 2
    and exists (
      select 1
      from public.device_signed_prekeys spk
      where spk.user_id = device.user_id
        and spk.device_id = device.device_id
        and spk.is_active = true
    )
  order by device.device_id;
$$;

revoke all on function public.get_sesame_device_list(uuid) from public, anon;
grant execute on function public.get_sesame_device_list(uuid) to authenticated;

drop function if exists public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, integer
);
create function public.register_user_device_safe(
  p_user_id uuid,
  p_device_id text,
  p_device_name text,
  p_device_public_key text,
  p_device_fingerprint text,
  p_platform text,
  p_user_agent text,
  p_device_signing_key text,
  p_device_identity_signature text,
  p_device_identity_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_existing public.user_devices%rowtype;
  v_now timestamptz := now();
begin
  if v_uid is null or p_user_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if length(v_device_id) < 8
     or length(coalesce(p_device_public_key, '')) not between 40 and 100
     or length(coalesce(p_device_signing_key, '')) not between 40 and 100
     or length(coalesce(p_device_identity_signature, '')) not between 80 and 180
     or p_device_identity_version <> 2 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_IDENTITY_V2');
  end if;

  select * into v_existing
  from public.user_devices
  where user_id = v_uid and device_id = v_device_id
  for update;

  if found and (
    v_existing.revoked_at is not null
    or v_existing.approval_status = 'rejected'
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  end if;
  if found and (
    v_existing.device_public_key is distinct from p_device_public_key
    or (
      v_existing.device_signing_key is not null
      and v_existing.device_signing_key is distinct from p_device_signing_key
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_IDENTITY_MISMATCH');
  end if;

  insert into public.user_devices (
    user_id, device_id, device_name, device_public_key,
    device_signing_key, device_identity_signature, device_identity_version,
    device_fingerprint, platform, user_agent, is_active, last_seen_at,
    approval_status, approval_requested_at, approved_at, approved_by,
    stale_at, routing_status, routing_error, routing_checked_at
  ) values (
    v_uid, v_device_id, p_device_name, p_device_public_key,
    p_device_signing_key, p_device_identity_signature, 2,
    p_device_fingerprint, p_platform, p_user_agent, true, v_now,
    'approved', v_now, v_now, v_uid, null,
    'repairing', 'SIGNED_PREKEY_VALIDATION_PENDING', v_now
  )
  on conflict (user_id, device_id) do update
  set device_name = excluded.device_name,
      device_fingerprint = excluded.device_fingerprint,
      platform = excluded.platform,
      user_agent = excluded.user_agent,
      last_seen_at = v_now,
      updated_at = v_now,
      is_active = true,
      approval_status = 'approved',
      approved_at = coalesce(public.user_devices.approved_at, v_now),
      approved_by = coalesce(public.user_devices.approved_by, v_uid),
      stale_at = null,
      device_signing_key = excluded.device_signing_key,
      device_identity_signature = excluded.device_identity_signature,
      device_identity_version = 2,
      routing_status = 'repairing',
      routing_error = 'SIGNED_PREKEY_VALIDATION_PENDING',
      routing_checked_at = v_now
  where public.user_devices.revoked_at is null
    and coalesce(public.user_devices.approval_status, 'approved') <> 'rejected';

  return jsonb_build_object(
    'ok', true,
    'code', 'ACCOUNT_AUTHORIZED_DEVICE_REGISTERED',
    'device_id', v_device_id
  );
end;
$$;

revoke all on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, integer
) from public, anon;
grant execute on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, integer
) to authenticated;

create or replace function public.mark_current_device_route_ready(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  update public.user_devices device
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = now()
  where device.user_id = v_uid
    and device.device_id = trim(p_device_id)
    and device.is_active = true
    and device.revoked_at is null
    and coalesce(device.approval_status, 'approved') = 'approved'
    and device.device_identity_version = 2
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_identity_signature), '') is not null
    and exists (
      select 1 from public.device_signed_prekeys spk
      where spk.user_id = v_uid
        and spk.device_id = trim(p_device_id)
        and spk.is_active = true
    );
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ROUTE_V2_INCOMPLETE');
  end if;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY_V2');
end;
$$;

commit;
''')

write("src/lib/messaging/__tests__/aegisWire.test.ts", r'''
import { describe, expect, it } from 'vitest';
import { bufferToBase64 } from '@/lib/crypto/utils';
import {
  AEGIS_INIT_PREFIX,
  AEGIS_RATCHET_PREFIX,
  createAegisSessionId,
  parseAegisInitWire,
  parseAegisRatchetWire,
} from '@/lib/messaging/aegisWire';

const b64 = (length: number, fill = 1) =>
  bufferToBase64(new Uint8Array(length).fill(fill).buffer as ArrayBuffer);

function ratchet(sessionId = createAegisSessionId()): string {
  return [
    `${AEGIS_RATCHET_PREFIX}${sessionId}`,
    b64(32, 2),
    '0',
    '0',
    b64(12, 3),
    b64(32, 4),
  ].join('.');
}

describe('bounded Aegis wire parser', () => {
  it('accepts a current header-bound ratchet and a matching init envelope', () => {
    const sessionId = createAegisSessionId();
    expect(sessionId).toMatch(/^s7[A-Za-z0-9_-]{22}$/);
    const inner = ratchet(sessionId);
    expect(parseAegisRatchetWire(inner)).toMatchObject({ sessionId, n: 0, pn: 0 });

    const innerB64 = bufferToBase64(new TextEncoder().encode(inner).buffer as ArrayBuffer);
    const init = [
      `${AEGIS_INIT_PREFIX}${sessionId}`,
      b64(32, 5),
      '1',
      '0',
      b64(32, 6),
      b64(32, 7),
      innerB64,
      b64(32, 8),
    ].join('.');
    expect(parseAegisInitWire(init)).toMatchObject({ sessionId, spkId: 1 });
  });

  it('rejects malformed lengths, counters, sessions and oversized ciphertext', () => {
    const sessionId = createAegisSessionId();
    expect(parseAegisRatchetWire(ratchet('legacy-session'))).toBeNull();
    expect(parseAegisRatchetWire(ratchet(sessionId).replace('.0.0.', '.-1.0.'))).toBeNull();
    expect(parseAegisRatchetWire(ratchet(sessionId).replace(b64(12, 3), b64(11, 3)))).toBeNull();
    expect(parseAegisRatchetWire(ratchet(sessionId).replace(b64(32, 2), b64(31, 2)))).toBeNull();
    expect(parseAegisRatchetWire(ratchet(sessionId).replace(b64(32, 4), b64(70 * 1024, 4)))).toBeNull();
  });
});
''')

write("src/lib/crypto/__tests__/accountAuthorizedDeviceIdentity.test.ts", r'''
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
  getOrCreateDeviceIdentity,
  signDeviceIdentityBinding,
  verifyDeviceIdentityBinding,
} from '@/lib/crypto/deviceIdentity';
import { bufferToBase64 } from '@/lib/crypto/utils';

async function exportRaw(key: CryptoKey): Promise<string> {
  return bufferToBase64(await crypto.subtle.exportKey('raw', key) as ArrayBuffer);
}

describe('account-authorized Sesame devices', () => {
  it('rejects a valid device self-signature unless the account key authorizes it', async () => {
    const device = await getOrCreateDeviceIdentity('user-v2', 'device-v2');
    const account = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const attacker = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const devicePublicKey = bufferToBase64(new Uint8Array(32).fill(9).buffer as ArrayBuffer);
    const signature = await signDeviceIdentityBinding({
      userId: 'user-v2',
      deviceId: 'device-v2',
      devicePublicKey,
      identity: device,
      accountSigningPrivateKey: account.privateKey,
      identityVersion: ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
    });

    expect(await verifyDeviceIdentityBinding({
      userId: 'user-v2',
      deviceId: 'device-v2',
      devicePublicKey,
      signingPublicKey: device.publicB64,
      signature,
      identityVersion: ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
      accountSigningPublicKey: await exportRaw(account.publicKey),
    })).toBe(true);

    expect(await verifyDeviceIdentityBinding({
      userId: 'user-v2',
      deviceId: 'device-v2',
      devicePublicKey,
      signingPublicKey: device.publicB64,
      signature,
      identityVersion: ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
      accountSigningPublicKey: await exportRaw(attacker.publicKey),
    })).toBe(false);
  });
});
''')

write("docs/AEGIS_SIGNAL_AUDIT_V2.md", r'''
# Aegis protocol audit v2 — Signal-aligned invariants

Aegis remains a custom WebCrypto/Supabase protocol. It is not Signal wire
compatible and does not currently implement PQXDH, Sparse Post-Quantum Ratchet
or Triple Ratchet.

This hardening release applies the following published Signal-style invariants:

1. A device route is authorized by the stable account Ed25519 key. A server can
   no longer add a self-signed device while leaving the account safety number
   unchanged.
2. Every accepted ratchet session authenticates its DH header. Existing `s6`
   sessions remain readable because they already authenticate the header; new
   sessions use a 128-bit `s7` identifier.
3. Ratchet and repeated-prekey wire inputs are parsed with strict field counts,
   base64 lengths, counter bounds and total-size limits before cryptographic
   state is touched.
4. The parent message envelope and key capsule are likewise bounded and tied to
   UUID identifiers before decryption.
5. Version-1 device rows are retained for migration but excluded from the
   authoritative route until the device re-registers with a version-2 account
   signature. No device is automatically revoked.

The repeated X3DH initial message continues to accompany initiation messages
until the first ratchet response, matching Sesame's recovery guidance. Active
and inactive device-pair sessions remain bounded and delayed messages may
promote a valid inactive session.
''')

print('Aegis Signal hardening phase 1 generated successfully')
