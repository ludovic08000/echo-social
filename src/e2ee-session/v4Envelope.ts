/**
 * v4 Envelope — canonical wire format for ALL new E2EE messages.
 *
 * The actual on-the-wire ciphertext stored in `messages.body` is still the
 * compact `x3dh4.<sessionId>.<seq>.<header>.<nonce>.<ct>` string produced by
 * `ratchetEncrypt` — this envelope is the structured façade used by upper
 * layers (router / queue / diagnostics) to reason about a message's
 * provenance without re-parsing the wire format every time.
 *
 * `payload` is ALWAYS the full encrypted wire string. Plaintext NEVER
 * appears here.
 *
 * Old envelopes (no `version` field, JSON-blob X3DH device-copies, etc.)
 * are NOT migrated. The legacy router still owns them. We only enforce v4
 * on new outbound traffic.
 */
import type { EncryptedMessageEnvelope } from './types';

export type V4Envelope = EncryptedMessageEnvelope;

export function isV4Envelope(value: unknown): value is V4Envelope {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<V4Envelope>;
  return (
    m.version === 4 &&
    typeof m.fromUserId === 'string' &&
    typeof m.toUserId === 'string' &&
    typeof m.fromDeviceId === 'string' &&
    typeof m.toDeviceId === 'string' &&
    typeof m.sessionId === 'string' &&
    typeof m.seq === 'number' &&
    typeof m.ciphertext === 'string'
  );
}

export function buildV4Envelope(input: {
  type: 'initial' | 'ratchet';
  fromUserId: string;
  toUserId: string;
  fromDeviceId: string;
  toDeviceId: string;
  sessionId: string;
  seq: number;
  /** Compact wire string (`x3dh4.<sessionId>.<seq>.<header>.<nonce>.<ct>`). */
  wire: string;
  nonce?: string;
  signature?: string;
}): V4Envelope {
  return {
    version: 4,
    type: input.type,
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    sessionId: input.sessionId,
    seq: input.seq,
    ciphertext: input.wire,
    nonce: input.nonce ?? '',
    signature: input.signature ?? '',
    createdAt: new Date().toISOString(),
  };
}

export function serializeV4Envelope(env: V4Envelope): string {
  return JSON.stringify(env);
}

export function parseV4Envelope(body: string): V4Envelope | null {
  try {
    const parsed = JSON.parse(body);
    return isV4Envelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
