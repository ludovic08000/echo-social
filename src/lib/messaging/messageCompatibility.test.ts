import { describe, expect, it } from 'vitest';
import {
  isCryptoJsonBody,
  isStrictRatchetEnvelopeBody,
  isUnsupportedEncryptedBody,
} from './messageCompatibility';

function envelope(version: number) {
  return JSON.stringify({
    encryptionMode: 'ratchet',
    v: version,
    kem: 'X25519',
    hdr: { dh: 'ZmFrZS1kaA==', pn: 0, n: 0 },
    iv: 'ZmFrZS1pdg==',
    ct: 'ZmFrZS1jaXBoZXJ0ZXh0',
    sig: 'ZmFrZS1zaWduYXR1cmU=',
    fp: 'AA BB CC DD',
    ts: Date.now(),
  });
}

describe('messageCompatibility', () => {
  it('routes supported ratchet versions 2 through 4', () => {
    expect(isStrictRatchetEnvelopeBody(envelope(2))).toBe(true);
    expect(isStrictRatchetEnvelopeBody(envelope(3))).toBe(true);
    expect(isStrictRatchetEnvelopeBody(envelope(4))).toBe(true);
  });

  it('rejects future and malformed versions', () => {
    expect(isStrictRatchetEnvelopeBody(envelope(1))).toBe(false);
    expect(isStrictRatchetEnvelopeBody(envelope(5))).toBe(false);
  });

  it('rejects negative or unsafe ratchet counters', () => {
    const parsed = JSON.parse(envelope(4));
    parsed.hdr.n = -1;
    expect(isStrictRatchetEnvelopeBody(JSON.stringify(parsed))).toBe(false);

    parsed.hdr.n = Number.MAX_SAFE_INTEGER + 1;
    expect(isStrictRatchetEnvelopeBody(JSON.stringify(parsed))).toBe(false);
  });

  it('does not classify ordinary JSON by substring alone', () => {
    const ordinary = JSON.stringify({ text: 'the string "ct" is documentation', ct: 'not-an-envelope' });
    expect(isCryptoJsonBody(ordinary)).toBe(false);
    expect(isUnsupportedEncryptedBody(ordinary)).toBe(false);
  });

  it('recognizes malformed encrypted structures as unsupported', () => {
    const malformed = JSON.stringify({ encryptionMode: 'ratchet', v: 4, ct: 'x' });
    expect(isCryptoJsonBody(malformed)).toBe(true);
    expect(isUnsupportedEncryptedBody(malformed)).toBe(true);
  });
});
