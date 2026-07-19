import { describe, expect, it } from 'vitest';
import {
  isKnownCryptoEnvelopeBody,
  isMultiDeviceEnvelopeBody,
  isUnsupportedEncryptedBody,
  SESAME_LITE_PROTOCOL,
  SESAME_LITE_VERSION,
} from '@/lib/messaging/messageCompatibility';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';

const sesameLiteEnvelope = {
  protocol: SESAME_LITE_PROTOCOL,
  version: SESAME_LITE_VERSION,
  encryptionMode: 'multi_device',
  v: PROTOCOL_VERSION,
  ct: 'device_copies',
  ts: 1777907800000,
};

describe('messageCompatibility', () => {
  it('accepts only the Sesame-lite parent envelope', () => {
    const body = JSON.stringify(sesameLiteEnvelope);
    expect(isMultiDeviceEnvelopeBody(body)).toBe(true);
    expect(isKnownCryptoEnvelopeBody(body)).toBe(true);
    expect(isUnsupportedEncryptedBody(body)).toBe(false);
  });

  it('rejects the former direct-ratchet envelope', () => {
    const body = JSON.stringify({
      encryptionMode: 'ratchet',
      v: PROTOCOL_VERSION,
      hdr: { dh: 'peer-dh', pn: 0, n: 1 },
      iv: 'iv',
      ct: 'ciphertext',
      sig: 'signature',
      fp: 'fingerprint',
      ts: 1777907800000,
    });

    expect(isMultiDeviceEnvelopeBody(body)).toBe(false);
    expect(isKnownCryptoEnvelopeBody(body)).toBe(false);
    expect(isUnsupportedEncryptedBody(body)).toBe(true);
  });

  it('rejects an unversioned encrypted parent', () => {
    const formerParent = JSON.stringify({
      encryptionMode: 'multi_device',
      v: PROTOCOL_VERSION,
      ct: 'device_copies',
      ts: 1777907800000,
    });

    expect(isMultiDeviceEnvelopeBody(formerParent)).toBe(false);
    expect(isUnsupportedEncryptedBody(formerParent)).toBe(true);
  });

  it('rejects malformed crypto JSON', () => {
    const body = JSON.stringify({
      protocol: SESAME_LITE_PROTOCOL,
      encryptionMode: 'multi_device',
      ct: 'device_copies',
    });

    expect(isKnownCryptoEnvelopeBody(body)).toBe(false);
    expect(isUnsupportedEncryptedBody(body)).toBe(true);
  });
});
