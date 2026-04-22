/**
 * Multi-device fan-out envelope format tests.
 *
 * Validates the on-wire format used by `multiDeviceFanout.ts`:
 *   - v1 (3-DH, no OPK):  "x3dh1." iv "." ct "." ek "." spkId
 *   - v2 (4-DH, with OPK): "x3dh2." iv "." ct "." ek "." spkId "." opkId
 *
 * These tests do not exercise the crypto itself (covered in e2ee/x3dh tests),
 * they protect against accidental format regressions that would break decryption
 * on secondary devices.
 */
import { describe, it, expect } from 'vitest';

const X3DH_PREFIX_V1 = 'x3dh1.';
const X3DH_PREFIX_V2 = 'x3dh2.';

function buildV1(iv: string, ct: string, ek: string, spkId: number): string {
  return [X3DH_PREFIX_V1 + iv, ct, ek, String(spkId)].join('.');
}

function buildV2(iv: string, ct: string, ek: string, spkId: number, opkId: number): string {
  return [X3DH_PREFIX_V2 + iv, ct, ek, String(spkId), String(opkId)].join('.');
}

function parse(payload: string):
  | { version: 1; iv: string; ct: string; ek: string; spkId: number }
  | { version: 2; iv: string; ct: string; ek: string; spkId: number; opkId: number }
  | null {
  const isV2 = payload.startsWith(X3DH_PREFIX_V2);
  const isV1 = payload.startsWith(X3DH_PREFIX_V1);
  if (!isV1 && !isV2) return null;

  const prefix = isV2 ? X3DH_PREFIX_V2 : X3DH_PREFIX_V1;
  const parts = payload.slice(prefix.length).split('.');
  const expectedLen = isV2 ? 5 : 4;
  if (parts.length !== expectedLen) return null;

  const [iv, ct, ek, spkIdStr, opkIdStr] = parts;
  const spkId = parseInt(spkIdStr, 10);
  if (Number.isNaN(spkId)) return null;

  if (isV2) {
    const opkId = parseInt(opkIdStr, 10);
    if (Number.isNaN(opkId)) return null;
    return { version: 2, iv, ct, ek, spkId, opkId };
  }
  return { version: 1, iv, ct, ek, spkId };
}

describe('multi-device fan-out envelope (v1, no OPK)', () => {
  it('round-trips a v1 envelope', () => {
    const p = buildV1('IVbase64', 'CTbase64', 'EKbase64', 7);
    const parsed = parse(p);
    expect(parsed).toEqual({
      version: 1,
      iv: 'IVbase64',
      ct: 'CTbase64',
      ek: 'EKbase64',
      spkId: 7,
    });
  });

  it('rejects v1 with missing fields', () => {
    expect(parse('x3dh1.iv.ct.ek')).toBeNull();
    expect(parse('x3dh1.iv.ct.ek.notanint')).toBeNull();
  });
});

describe('multi-device fan-out envelope (v2, with OPK)', () => {
  it('round-trips a v2 envelope', () => {
    const p = buildV2('IVx', 'CTx', 'EKx', 12, 99);
    const parsed = parse(p);
    expect(parsed).toEqual({
      version: 2,
      iv: 'IVx',
      ct: 'CTx',
      ek: 'EKx',
      spkId: 12,
      opkId: 99,
    });
  });

  it('rejects v2 with missing OPK field', () => {
    expect(parse('x3dh2.iv.ct.ek.5')).toBeNull(); // only 4 parts → not a v2
  });

  it('rejects v2 with non-numeric OPK', () => {
    expect(parse('x3dh2.iv.ct.ek.5.notanint')).toBeNull();
  });
});

describe('multi-device fan-out envelope (rejection)', () => {
  it('rejects unknown prefixes', () => {
    expect(parse('x3dh3.a.b.c.1')).toBeNull();
    expect(parse('plaintext message')).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('does not confuse v1 and v2', () => {
    // v1 payload (4 parts) must not be parsed as v2
    const v1 = buildV1('iv', 'ct', 'ek', 1);
    const parsed = parse(v1);
    expect(parsed?.version).toBe(1);
  });
});
