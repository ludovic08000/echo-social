import { hardCrypto, hardGlobals, scrubBuffer } from '@/lib/crypto/cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';

export const AEGIS_MESSAGE_PROTOCOL = 'forsure-aegis-message';
export const AEGIS_KEY_PROTOCOL = 'forsure-aegis-key';
export const AEGIS_WIRE_VERSION = 1;

const CONTENT_KEY_BYTES = 32;
const IV_BYTES = 12;
const AAD_PREFIX = 'FORSURE-AEGIS-MESSAGE-v1|';

export interface AegisMessageEnvelope {
  protocol: typeof AEGIS_MESSAGE_PROTOCOL;
  version: typeof AEGIS_WIRE_VERSION;
  encryptionMode: 'multi_device';
  algorithm: 'AES-256-GCM';
  keyTransport: 'device_ratchet';
  messageId: string;
  conversationId: string;
  senderId: string;
  iv: string;
  ciphertext: string;
  digest: string;
  createdAt: number;
  localId?: string;
  traceId?: string;
}

export interface AegisKeyCapsule {
  protocol: typeof AEGIS_KEY_PROTOCOL;
  version: typeof AEGIS_WIRE_VERSION;
  messageId: string;
  conversationId: string;
  senderId: string;
  contentKey: string;
  digest: string;
}

export interface CreateAegisMessageInput {
  messageId: string;
  conversationId: string;
  senderId: string;
  plaintext: string;
  localId?: string;
  traceId?: string;
  createdAt?: number;
}

export interface OpenAegisMessageExpectation {
  messageId: string;
  conversationId?: string;
  senderId?: string;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function aadFor(messageId: string, conversationId: string, senderId: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(
    `${AAD_PREFIX}${messageId}|${conversationId}|${senderId}`,
  );
}

async function digestPayload(iv: Uint8Array, ciphertext: ArrayBuffer): Promise<string> {
  const ciphertextBytes = new Uint8Array(ciphertext);
  const combined = new Uint8Array(iv.byteLength + ciphertextBytes.byteLength);
  combined.set(iv, 0);
  combined.set(ciphertextBytes, iv.byteLength);
  const digest = await hardCrypto.digest('SHA-256', exactArrayBuffer(combined));
  return bufferToBase64(digest);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseAegisMessageEnvelope(
  body: string | null | undefined,
): AegisMessageEnvelope | null {
  if (!body || !body.startsWith('{')) return null;
  try {
    const parsed = hardGlobals.jsonParse(body) as Partial<AegisMessageEnvelope>;
    if (
      parsed.protocol !== AEGIS_MESSAGE_PROTOCOL ||
      parsed.version !== AEGIS_WIRE_VERSION ||
      parsed.encryptionMode !== 'multi_device' ||
      parsed.algorithm !== 'AES-256-GCM' ||
      parsed.keyTransport !== 'device_ratchet' ||
      !isNonEmptyString(parsed.messageId) ||
      !isNonEmptyString(parsed.conversationId) ||
      !isNonEmptyString(parsed.senderId) ||
      !isNonEmptyString(parsed.iv) ||
      !isNonEmptyString(parsed.ciphertext) ||
      !isNonEmptyString(parsed.digest) ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt)
    ) {
      return null;
    }
    return parsed as AegisMessageEnvelope;
  } catch {
    return null;
  }
}

export function parseAegisKeyCapsule(value: string | null | undefined): AegisKeyCapsule | null {
  if (!value || !value.startsWith('{')) return null;
  try {
    const parsed = hardGlobals.jsonParse(value) as Partial<AegisKeyCapsule>;
    if (
      parsed.protocol !== AEGIS_KEY_PROTOCOL ||
      parsed.version !== AEGIS_WIRE_VERSION ||
      !isNonEmptyString(parsed.messageId) ||
      !isNonEmptyString(parsed.conversationId) ||
      !isNonEmptyString(parsed.senderId) ||
      !isNonEmptyString(parsed.contentKey) ||
      !isNonEmptyString(parsed.digest)
    ) {
      return null;
    }
    const raw = new Uint8Array(base64ToBuffer(parsed.contentKey));
    if (raw.byteLength !== CONTENT_KEY_BYTES) return null;
    return parsed as AegisKeyCapsule;
  } catch {
    return null;
  }
}

export async function createAegisMessage(
  input: CreateAegisMessageInput,
): Promise<{ body: string; keyCapsule: string; envelope: AegisMessageEnvelope }> {
  if (!input.messageId || !input.conversationId || !input.senderId) {
    throw new Error('AEGIS_MESSAGE_IDENTITY_REQUIRED');
  }

  const rawKey = hardCrypto.getRandomValues(new Uint8Array(CONTENT_KEY_BYTES));
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_BYTES));
  try {
    const key = await hardCrypto.importKey(
      'raw',
      exactArrayBuffer(rawKey),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const aad = aadFor(input.messageId, input.conversationId, input.senderId);
    const ciphertext = await hardCrypto.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as Uint8Array<ArrayBuffer>,
        additionalData: exactArrayBuffer(aad),
        tagLength: 128,
      },
      key,
      new hardGlobals.TextEncoder().encode(input.plaintext),
    );
    const digest = await digestPayload(iv, ciphertext);
    const envelope: AegisMessageEnvelope = {
      protocol: AEGIS_MESSAGE_PROTOCOL,
      version: AEGIS_WIRE_VERSION,
      encryptionMode: 'multi_device',
      algorithm: 'AES-256-GCM',
      keyTransport: 'device_ratchet',
      messageId: input.messageId,
      conversationId: input.conversationId,
      senderId: input.senderId,
      iv: bufferToBase64(exactArrayBuffer(iv)),
      ciphertext: bufferToBase64(ciphertext),
      digest,
      createdAt: input.createdAt ?? Date.now(),
      ...(input.localId ? { localId: input.localId } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    };
    const capsule: AegisKeyCapsule = {
      protocol: AEGIS_KEY_PROTOCOL,
      version: AEGIS_WIRE_VERSION,
      messageId: input.messageId,
      conversationId: input.conversationId,
      senderId: input.senderId,
      contentKey: bufferToBase64(exactArrayBuffer(rawKey)),
      digest,
    };
    return {
      body: hardGlobals.jsonStringify(envelope),
      keyCapsule: hardGlobals.jsonStringify(capsule),
      envelope,
    };
  } finally {
    scrubBuffer(rawKey);
  }
}

export async function openAegisMessage(
  body: string,
  keyCapsule: string,
  expected: OpenAegisMessageExpectation,
): Promise<string | null> {
  const envelope = parseAegisMessageEnvelope(body);
  const capsule = parseAegisKeyCapsule(keyCapsule);
  if (!envelope || !capsule) return null;

  if (
    envelope.messageId !== expected.messageId ||
    capsule.messageId !== expected.messageId ||
    envelope.messageId !== capsule.messageId ||
    envelope.conversationId !== capsule.conversationId ||
    envelope.senderId !== capsule.senderId ||
    envelope.digest !== capsule.digest ||
    (expected.conversationId !== undefined && envelope.conversationId !== expected.conversationId) ||
    (expected.senderId !== undefined && envelope.senderId !== expected.senderId)
  ) {
    return null;
  }

  try {
    const iv = new Uint8Array(base64ToBuffer(envelope.iv));
    const ciphertext = base64ToBuffer(envelope.ciphertext);
    if (iv.byteLength !== IV_BYTES) return null;
    if ((await digestPayload(iv, ciphertext)) !== envelope.digest) return null;

    const rawKey = new Uint8Array(base64ToBuffer(capsule.contentKey));
    if (rawKey.byteLength !== CONTENT_KEY_BYTES) return null;
    try {
      const key = await hardCrypto.importKey(
        'raw',
        exactArrayBuffer(rawKey),
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      const aad = aadFor(envelope.messageId, envelope.conversationId, envelope.senderId);
      const plaintext = await hardCrypto.decrypt(
        {
          name: 'AES-GCM',
          iv: iv as Uint8Array<ArrayBuffer>,
          additionalData: exactArrayBuffer(aad),
          tagLength: 128,
        },
        key,
        ciphertext,
      );
      return new hardGlobals.TextDecoder().decode(plaintext);
    } finally {
      scrubBuffer(rawKey);
    }
  } catch {
    return null;
  }
}

export const __test__ = { aadFor };
