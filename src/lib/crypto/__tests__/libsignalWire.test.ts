import { describe, expect, it } from 'vitest';
import { decodeLibsignalWire, encodeLibsignalWire } from '../libsignalWire';

describe('libsignal wire contract shared with SQL', () => {
  it.each([2, 3])('round trips type %i including padded and long payloads', (type) => {
    for (const size of [1, 2, 3, 100]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256);
      expect(decodeLibsignalWire(encodeLibsignalWire(type, bytes))).toEqual({ messageType: type, ciphertext: bytes });
    }
  });
  it.each(['aegis1.ratchet.AQID', 'aegis.libsignal.7.AQID', 'aegis.libsignal.8.AQID', 'aegis.libsignal.03.AQID', 'aegis.libsignal..AQID', 'aegis.libsignal.3.', 'aegis.libsignal.3.AQ', 'aegis.libsignal.3.AR==', 'aegis.libsignal.3.AQID\n', 'aegis.libsignal.3.AQID.extra'])('rejects %j', (wire) => {
    expect(decodeLibsignalWire(wire)).toBeNull();
  });
  it('rejects unsupported types and empty ciphertext on encode', () => {
    expect(() => encodeLibsignalWire(7, new Uint8Array([1]))).toThrow('AEGIS_LIBSIGNAL_TYPE_INVALID');
    expect(() => encodeLibsignalWire(3, new Uint8Array())).toThrow('AEGIS_LIBSIGNAL_CIPHERTEXT_EMPTY');
  });
});
