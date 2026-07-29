import { describe, expect, it } from 'vitest';
import { bufferToBase64 } from '@/lib/crypto/utils';
import {
  AEGIS_INIT_PREFIX,
  AEGIS_RATCHET_PREFIX,
  createAegisSessionId,
} from '@/lib/messaging/aegisWire';
import {
  isKnownCryptoEnvelopeBody,
  isAegisDeviceCopyWire,
  isMultiDeviceEnvelopeBody,
  isUnsupportedEncryptedBody,
  AEGIS_PROTOCOL,
  AEGIS_VERSION,
} from '@/lib/messaging/messageCompatibility';

const bytes = (length: number, fill: number) =>
  bufferToBase64(new Uint8Array(length).fill(fill).buffer as ArrayBuffer);

const aegisEnvelope = {
  protocol: AEGIS_PROTOCOL,
  version: AEGIS_VERSION,
  encryptionMode: 'multi_device',
  algorithm: 'AES-256-GCM',
  keyTransport: 'device_ratchet',
  messageId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  senderId: '33333333-3333-4333-8333-333333333333',
  iv: bytes(12, 1),
  ciphertext: bytes(32, 2),
  digest: bytes(32, 3),
  createdAt: 1777907800000,
};

function validRatchet(sessionId: string): string {
  return [
    `${AEGIS_RATCHET_PREFIX}${sessionId}`,
    bytes(32, 4),
    '0',
    '0',
    bytes(12, 5),
    bytes(32, 6),
  ].join('.');
}

function validInit(sessionId: string): string {
  const inner = validRatchet(sessionId);
  const innerB64 = bufferToBase64(new TextEncoder().encode(inner).buffer as ArrayBuffer);
  return [
    `${AEGIS_INIT_PREFIX}${sessionId}`,
    bytes(32, 7),
    '1',
    '0',
    bytes(32, 8),
    bytes(32, 9),
    innerB64,
    bytes(32, 10),
  ].join('.');
}

describe('messageCompatibility', () => {
  it('accepts only a structurally valid Aegis v1 parent envelope', () => {
    const body = JSON.stringify(aegisEnvelope);
    expect(isMultiDeviceEnvelopeBody(body)).toBe(true);
    expect(isKnownCryptoEnvelopeBody(body)).toBe(true);
    expect(isUnsupportedEncryptedBody(body)).toBe(false);
  });

  it('rejects the former direct-ratchet envelope', () => {
    const body = JSON.stringify({
      encryptionMode: 'ratchet',
      v: 4,
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
      v: 4,
      ct: 'device_copies',
      ts: 1777907800000,
    });
    expect(isMultiDeviceEnvelopeBody(formerParent)).toBe(false);
    expect(isUnsupportedEncryptedBody(formerParent)).toBe(true);
  });

  it('rejects malformed crypto JSON', () => {
    const body = JSON.stringify({
      protocol: AEGIS_PROTOCOL,
      encryptionMode: 'multi_device',
      ct: 'device_copies',
    });
    expect(isKnownCryptoEnvelopeBody(body)).toBe(false);
    expect(isUnsupportedEncryptedBody(body)).toBe(true);
  });

  it('accepts only complete, bounded Aegis device-copy wires', () => {
    const sessionId = createAegisSessionId();
    expect(isAegisDeviceCopyWire(validRatchet(sessionId))).toBe(true);
    expect(isAegisDeviceCopyWire(validInit(sessionId))).toBe(true);
    expect(isAegisDeviceCopyWire('aegis1.ratchet.session.dh.0.0.iv.ct')).toBe(false);
    expect(isAegisDeviceCopyWire('aegis1.init.v1.session.payload')).toBe(false);
    expect(isAegisDeviceCopyWire('x3dh5.init.v3.payload')).toBe(false);
    expect(isAegisDeviceCopyWire('aegis1.init.v2.payload')).toBe(false);
    expect(isAegisDeviceCopyWire(null)).toBe(false);
  });
});
