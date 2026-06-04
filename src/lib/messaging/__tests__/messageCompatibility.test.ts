import { describe, expect, it } from 'vitest';
import {
  isKnownCryptoEnvelopeBody,
  isStrictRatchetEnvelopeBody,
  isUnsupportedEncryptedBody,
} from '@/lib/messaging/messageCompatibility';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';

const baseRatchetEnvelope = {
  encryptionMode: 'ratchet',
  v: PROTOCOL_VERSION,
  kem: 'X25519',
  hdr: { dh: 'peer-dh', pn: 0, n: 1 },
  iv: 'iv',
  ct: 'ciphertext',
  sig: 'signature',
  fp: 'fingerprint',
  ts: 1777907800000,
};

describe('messageCompatibility', () => {
  it('accepts the current strict ratchet envelope', () => {
    const body = JSON.stringify(baseRatchetEnvelope);
    expect(isStrictRatchetEnvelopeBody(body)).toBe(true);
    expect(isKnownCryptoEnvelopeBody(body)).toBe(true);
    expect(isUnsupportedEncryptedBody(body)).toBe(false);
  });

  it('does not mark legacy ratchet-shaped envelopes as unsupported', () => {
    const body = JSON.stringify({
      ...baseRatchetEnvelope,
      encryptionMode: undefined,
      v: 1,
    });

    expect(isStrictRatchetEnvelopeBody(body)).toBe(false);
    expect(isKnownCryptoEnvelopeBody(body)).toBe(true);
    expect(isUnsupportedEncryptedBody(body)).toBe(false);
  });

  it('accepts secure-pipeline wrapped ratchet envelopes as recoverable crypto', () => {
    const body = JSON.stringify({
      fs_secure_pipeline: 1,
      body: JSON.stringify(baseRatchetEnvelope),
      meta: { identityEpoch: 1, payload: { localId: 'local-test' } },
    });

    expect(isKnownCryptoEnvelopeBody(body)).toBe(true);
    expect(isUnsupportedEncryptedBody(body)).toBe(false);
  });

  it('still flags malformed crypto JSON as unsupported', () => {
    const body = JSON.stringify({
      encryptionMode: 'ratchet',
      ct: 'ciphertext',
      hdr: { dh: 'peer-dh' },
    });

    expect(isKnownCryptoEnvelopeBody(body)).toBe(false);
    expect(isUnsupportedEncryptedBody(body)).toBe(true);
  });
});
