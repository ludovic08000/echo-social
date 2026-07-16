import { describe, expect, it } from 'vitest';
import { bufferToBase64 } from '@/lib/crypto/utils';
import { __test__, isRepeatablePreKeyEnvelope, parseRepeatablePreKeyEnvelope } from '../repeatablePreKeyEnvelope';

function b64(value: string): string {
  return bufferToBase64(new TextEncoder().encode(value).buffer as ArrayBuffer);
}

function envelope(overrides: Partial<{
  sessionId: string;
  innerSessionId: string;
  spkId: string;
  opkId: string;
}> = {}): string {
  const sessionId = overrides.sessionId ?? 'sessionABC123';
  const innerSessionId = overrides.innerSessionId ?? sessionId;
  const inner = `x3dh5.${innerSessionId}.dh-public.0.0.iv.ct`;
  return [
    `${__test__.prefix}${sessionId}`,
    'ephemeral-key',
    overrides.spkId ?? '17',
    overrides.opkId ?? '23',
    'sender-identity',
    'recipient-identity',
    b64(inner),
    'authentication-tag',
  ].join('.');
}

describe('repeatable pre-key envelope v3', () => {
  it('parses a repeatable envelope carrying a matching Double Ratchet session', () => {
    const payload = envelope();
    const parsed = parseRepeatablePreKeyEnvelope(payload);

    expect(isRepeatablePreKeyEnvelope(payload)).toBe(true);
    expect(parsed).toMatchObject({
      sessionId: 'sessionABC123',
      spkId: 17,
      opkId: 23,
      senderIdentityKeyB64: 'sender-identity',
      recipientIdentityKeyB64: 'recipient-identity',
      innerRatchet: 'x3dh5.sessionABC123.dh-public.0.0.iv.ct',
    });
  });

  it('rejects an envelope whose inner ratchet belongs to another session', () => {
    expect(parseRepeatablePreKeyEnvelope(envelope({ innerSessionId: 'otherSession' }))).toBeNull();
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
