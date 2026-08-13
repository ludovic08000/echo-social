import { describe, expect, it } from 'vitest';
import { unpackWasmSignedPrekey } from '@/lib/crypto/aegisWasmBridge';

function pack(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + 4 + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    new DataView(result.buffer).setUint32(offset, part.length, true);
    offset += 4;
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe('Aegis libsignal WASM bridge', () => {
  it('separates the private SPK record from publishable material', () => {
    const decoded = unpackWasmSignedPrekey(pack(
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(4, 5),
      Uint8Array.of(6, 7, 8, 9),
    ));
    expect([...decoded.privateRecord]).toEqual([1, 2, 3]);
    expect([...decoded.publicKey]).toEqual([4, 5]);
    expect([...decoded.signature]).toEqual([6, 7, 8, 9]);
  });

  it('rejects truncated or trailing data', () => {
    expect(() => unpackWasmSignedPrekey(Uint8Array.of(1, 0, 0))).toThrow('PACK_INVALID');
    expect(() => unpackWasmSignedPrekey(pack(
      Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3), Uint8Array.of(4),
    ))).toThrow('PACK_INVALID');
  });
});

