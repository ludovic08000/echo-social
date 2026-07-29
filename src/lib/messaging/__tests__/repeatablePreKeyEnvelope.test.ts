import { describe, expect, it } from 'vitest';
import { bufferToBase64 } from '@/lib/crypto/utils';
import { createAegisSessionId } from '@/lib/messaging/aegisWire';
import { __test__, isRepeatablePreKeyEnvelope, parseRepeatablePreKeyEnvelope } from '../repeatablePreKeyEnvelope';

const bytes = (length: number, fill: number) =>
  bufferToBase64(new Uint8Array(length).fill(fill).buffer as ArrayBuffer);

function b64(value: string): string {
  return bufferToBase64(new TextEncoder().encode(value).buffer as ArrayBuffer);
}

function envelope(overrides: Partial<{
  sessionId: string;
  innerSessionId: string;
  spkId: string;
  opkId: string;
}> = {}): string {
  const sessionId = overrides.sessionId ?? createAegisSessionId();
  const innerSessionId = overrides.innerSessionId ?? sessionId;
  const inner = [
    `aegis1.ratchet.${innerSessionId}`,
    bytes(32, 1),
    '0',
    '0',
    bytes(12, 2),
    bytes(32, 3),
  ].join('.');
  return [
    `${__test__.prefix}${sessionId}`,
    bytes(32, 4),
    overrides.spkId ?? '17',
    overrides.opkId ?? '23',
    bytes(32, 5),
    bytes(32, 6),
    b64(inner),
    bytes(32, 7),
  ].join('.');
}

describe('repeatable pre-key envelope v3', () => {
  it('parses a complete envelope carrying a matching Double Ratchet session', () => {
    const sessionId = createAegisSessionId();
    const payload = envelope({ sessionId });
    const parsed = parseRepeatablePreKeyEnvelope(payload);
    expect(isRepeatablePreKeyEnvelope(payload)).toBe(true);
    expect(parsed).toMatchObject({
      sessionId,
      spkId: 17,
      opkId: 23,
      senderIdentityKeyB64: bytes(32, 5),
      recipientIdentityKeyB64: bytes(32, 6),
    });
  });

  it('rejects an envelope whose inner ratchet belongs to another session', () => {
    expect(parseRepeatablePreKeyEnvelope(envelope({
      innerSessionId: createAegisSessionId(),
    }))).toBeNull();
  });

  it('accepts an SPK-only bootstrap but rejects invalid pre-key identifiers', () => {
    expect(parseRepeatablePreKeyEnvelope(envelope({ opkId: '0' }))?.opkId).toBeUndefined();
    expect(parseRepeatablePreKeyEnvelope(envelope({ spkId: '0' }))).toBeNull();
    expect(parseRepeatablePreKeyEnvelope(envelope({ opkId: '-1' }))).toBeNull();
  });

  it('keeps initiation bounded', () => {
    expect(__test__.maxInitiatingMessages).toBe(100);
    expect(__test__.initiatingTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
