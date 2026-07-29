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
