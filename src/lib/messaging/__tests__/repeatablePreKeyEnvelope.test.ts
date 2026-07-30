import { describe, expect, it } from 'vitest';
import {
  VALID_AEGIS_SESSION_ID,
  VALID_INIT_COPY,
  VALID_RATCHET_COPY,
  VALID_X25519_KEY,
  VALID_X25519_KEY_2,
} from '@/test/aegisWireFixtures';
import { bufferToBase64 } from '@/lib/crypto/utils';
import { __test__, isRepeatablePreKeyEnvelope, parseRepeatablePreKeyEnvelope } from '../repeatablePreKeyEnvelope';

function replacePart(payload: string, index: number, value: string): string {
  const parts = payload.slice(__test__.prefix.length).split('.');
  parts[index] = value;
  return `${__test__.prefix}${parts.join('.')}`;
}

describe('repeatable pre-key envelope', () => {
  it('parses a bounded envelope carrying the same authenticated Ratchet session', () => {
    const parsed = parseRepeatablePreKeyEnvelope(VALID_INIT_COPY);
    expect(isRepeatablePreKeyEnvelope(VALID_INIT_COPY)).toBe(true);
    expect(parsed).toMatchObject({
      sessionId: VALID_AEGIS_SESSION_ID,
      spkId: 17,
      opkId: 23,
      senderIdentityKeyB64: VALID_X25519_KEY,
      recipientIdentityKeyB64: VALID_X25519_KEY_2,
      innerRatchet: VALID_RATCHET_COPY,
    });
  });

  it('rejects an envelope whose inner Ratchet belongs to another session', () => {
    const otherInner = VALID_RATCHET_COPY.replace(VALID_AEGIS_SESSION_ID, 's_BBBBBBBBBBBBBBBBBBBBBB');
    const otherInnerB64 = bufferToBase64(new TextEncoder().encode(otherInner).buffer as ArrayBuffer);
    expect(parseRepeatablePreKeyEnvelope(replacePart(VALID_INIT_COPY, 6, otherInnerB64))).toBeNull();
  });

  it('accepts SPK-only bootstrap and rejects malformed keys or pre-key identifiers', () => {
    expect(parseRepeatablePreKeyEnvelope(replacePart(VALID_INIT_COPY, 3, '0'))?.opkId).toBeUndefined();
    expect(parseRepeatablePreKeyEnvelope(replacePart(VALID_INIT_COPY, 2, '0'))).toBeNull();
    expect(parseRepeatablePreKeyEnvelope(replacePart(VALID_INIT_COPY, 3, '-1'))).toBeNull();
    expect(parseRepeatablePreKeyEnvelope(replacePart(VALID_INIT_COPY, 1, 'AA=='))).toBeNull();
  });

  it('keeps initiation bounded', () => {
    expect(__test__.maxInitiatingMessages).toBe(100);
    expect(__test__.initiatingTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
