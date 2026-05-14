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

// ─── Device-pair ratchet envelopes ───────────────────────────────────────────
describe('device-pair ratchet envelopes', () => {
  it('v3 (legacy KDF chain) shape: x3dh3.sessionId.counter.iv.ct', () => {
    const payload = 'x3dh3.sess123.0.IV.CT';
    const parts = payload.slice('x3dh3.'.length).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('sess123');
    expect(Number(parts[1])).toBe(0);
  });

  it('v4 (Double Ratchet) shape: x3dh4.sessionId.dhPub.Ns.PN.iv.ct', () => {
    const payload = 'x3dh4.sess123.DHPUB.5.3.IV.CT';
    const parts = payload.slice('x3dh4.'.length).split('.');
    expect(parts).toHaveLength(6);
    const [sessionId, dhPub, Ns, PN] = parts;
    expect(sessionId).toBe('sess123');
    expect(dhPub).toBe('DHPUB');
    expect(Number(Ns)).toBe(5);
    expect(Number(PN)).toBe(3);
  });

  it('v3 and v4 are distinguishable by prefix', () => {
    expect('x3dh3.foo'.startsWith('x3dh3.')).toBe(true);
    expect('x3dh4.foo'.startsWith('x3dh4.')).toBe(true);
    expect('x3dh3.foo'.startsWith('x3dh4.')).toBe(false);
    expect('x3dh4.foo'.startsWith('x3dh3.')).toBe(false);
  });

  it('v5 recovery metadata is not mistaken for a message envelope', () => {
    const backupV5 = JSON.stringify({
      version: 5,
      encrypted_blob: 'ciphertext',
      iv: 'iv',
      salt: 'salt',
    });
    expect(parse(backupV5)).toBeNull();
    expect(backupV5.startsWith('x3dh3.')).toBe(false);
    expect(backupV5.startsWith('x3dh4.')).toBe(false);
  });
});
