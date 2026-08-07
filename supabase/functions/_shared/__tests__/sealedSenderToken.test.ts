import { describe, expect, it } from 'vitest';
import {
  SEALED_SENDER_PROTOCOL_VERSION,
  canonicalTokenPayload,
  decodeSignedToken,
  encodeSignedToken,
  signTokenPayload,
  validateTokenTime,
  verifyTokenMac,
  type SealedSenderTokenPayloadV1,
} from '../sealedSenderToken';

const secret = 'test-only-sealed-sender-secret-with-adequate-length';

function payload(overrides: Partial<SealedSenderTokenPayloadV1> = {}): SealedSenderTokenPayloadV1 {
  const issued = new Date('2026-08-06T20:00:00.000Z');
  return {
    version: SEALED_SENDER_PROTOCOL_VERSION,
    sender_user_id: '11111111-1111-4111-8111-111111111111',
    recipient_user_id: '22222222-2222-4222-8222-222222222222',
    conversation_id: '33333333-3333-4333-8333-333333333333',
    nonce: 'a'.repeat(64),
    issued_at: issued.toISOString(),
    expires_at: new Date(issued.getTime() + 300_000).toISOString(),
    context_id: 'send-context-1',
    ...overrides,
  };
}

describe('Sealed Sender v1 token', () => {
  it('round-trips a valid signed token', async () => {
    const value = payload();
    const mac = await signTokenPayload(value, secret);
    const decoded = decodeSignedToken(encodeSignedToken({ payload: value, mac }));
    expect(decoded.payload).toEqual(value);
    expect(await verifyTokenMac(decoded.payload, decoded.mac, secret)).toBe(true);
  });

  it.each([
    ['conversation_id', '44444444-4444-4444-8444-444444444444'],
    ['recipient_user_id', '55555555-5555-4555-8555-555555555555'],
    ['sender_user_id', '66666666-6666-4666-8666-666666666666'],
    ['nonce', 'b'.repeat(64)],
    ['context_id', 'other-context'],
  ] as const)('rejects an altered %s through the MAC', async (field, replacement) => {
    const original = payload();
    const mac = await signTokenPayload(original, secret);
    const altered = { ...original, [field]: replacement };
    expect(await verifyTokenMac(altered, mac, secret)).toBe(false);
  });

  it('uses a deterministic canonical representation', () => {
    const value = payload();
    expect(canonicalTokenPayload(value)).toBe(canonicalTokenPayload({ ...value }));
  });

  it('rejects expired and overlong lifetimes', () => {
    expect(validateTokenTime(payload(), Date.parse('2026-08-06T20:06:00.000Z'))).toBe('expired');
    expect(validateTokenTime(payload({
      expires_at: '2026-08-06T21:00:00.000Z',
    }), Date.parse('2026-08-06T20:00:01.000Z'))).toBe('invalid_lifetime');
  });

  it('rejects an unknown protocol version', () => {
    const value = { ...payload(), version: 2 };
    const encoded = encodeSignedToken({
      payload: value as unknown as SealedSenderTokenPayloadV1,
      mac: 'a'.repeat(43),
    });
    expect(() => decodeSignedToken(encoded)).toThrow('invalid_token');
  });
});
