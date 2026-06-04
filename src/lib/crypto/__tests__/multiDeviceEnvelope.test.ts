/**
 * Multi-device fan-out envelope format tests.
 *
 * New device-copy bootstraps are pinned to:
 *   x3dh5.init.iv.ct.ek.spkId[.opkId]
 *
 * Device-pair ratchet messages are pinned to:
 *   x3dh5.sessionId.dhPub.Ns.PN.iv.ct
 *
 * v4 is accepted as a temporary read-only compatibility format. Pre-v4
 * fan-out/device-copy formats are retired from runtime routing.
 */
import { describe, it, expect } from 'vitest';

const X3DH_BOOTSTRAP_PREFIX_V5 = 'x3dh5.init.';
const RATCHET_PREFIX_V5 = 'x3dh5.';
const RATCHET_PREFIX_V4 = 'x3dh4.';

function buildV5Bootstrap(iv: string, ct: string, ek: string, spkId: number, opkId?: number): string {
  const fields = [X3DH_BOOTSTRAP_PREFIX_V5 + iv, ct, ek, String(spkId)];
  if (opkId !== undefined) fields.push(String(opkId));
  return fields.join('.');
}

function parseV5Bootstrap(payload: string):
  | { iv: string; ct: string; ek: string; spkId: number; opkId?: number }
  | null {
  if (!payload.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return null;
  const parts = payload.slice(X3DH_BOOTSTRAP_PREFIX_V5.length).split('.');
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [iv, ct, ek, spkIdStr, opkIdStr] = parts;
  const spkId = parseInt(spkIdStr, 10);
  if (Number.isNaN(spkId)) return null;
  if (opkIdStr === undefined) return { iv, ct, ek, spkId };
  const opkId = parseInt(opkIdStr, 10);
  if (Number.isNaN(opkId)) return null;
  return { iv, ct, ek, spkId, opkId };
}

describe('multi-device fan-out bootstrap envelope v5', () => {
  it('round-trips a v5 bootstrap envelope without OPK', () => {
    const payload = buildV5Bootstrap('IVbase64', 'CTbase64', 'EKbase64', 7);
    expect(parseV5Bootstrap(payload)).toEqual({
      iv: 'IVbase64',
      ct: 'CTbase64',
      ek: 'EKbase64',
      spkId: 7,
    });
  });

  it('round-trips a v5 bootstrap envelope with OPK', () => {
    const payload = buildV5Bootstrap('IVx', 'CTx', 'EKx', 12, 99);
    expect(parseV5Bootstrap(payload)).toEqual({
      iv: 'IVx',
      ct: 'CTx',
      ek: 'EKx',
      spkId: 12,
      opkId: 99,
    });
  });

  it('rejects retired fan-out prefixes', () => {
    expect(parseV5Bootstrap('x3dh1.iv.ct.ek.5')).toBeNull();
    expect(parseV5Bootstrap('x3dh2.iv.ct.ek.5.1')).toBeNull();
    expect(parseV5Bootstrap('x3dh3.session.0.iv.ct')).toBeNull();
    expect(parseV5Bootstrap('plaintext message')).toBeNull();
    expect(parseV5Bootstrap('')).toBeNull();
  });

  it('rejects malformed numeric fields', () => {
    expect(parseV5Bootstrap('x3dh5.init.iv.ct.ek.notanint')).toBeNull();
    expect(parseV5Bootstrap('x3dh5.init.iv.ct.ek.5.notanint')).toBeNull();
  });
});

describe('device-pair ratchet envelopes', () => {
  it('v5 shape: x3dh5.sessionId.dhPub.Ns.PN.iv.ct', () => {
    const payload = 'x3dh5.sess123.DHPUB.5.3.IV.CT';
    const parts = payload.slice(RATCHET_PREFIX_V5.length).split('.');
    expect(parts).toHaveLength(6);
    const [sessionId, dhPub, ns, pn] = parts;
    expect(sessionId).toBe('sess123');
    expect(dhPub).toBe('DHPUB');
    expect(Number(ns)).toBe(5);
    expect(Number(pn)).toBe(3);
  });

  it('v4 compatibility shape: x3dh4.sessionId.dhPub.Ns.PN.iv.ct', () => {
    const payload = 'x3dh4.sess123.DHPUB.5.3.IV.CT';
    const parts = payload.slice(RATCHET_PREFIX_V4.length).split('.');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('sess123');
  });

  it('v5, v4, and retired v3 are distinguishable by prefix', () => {
    expect('x3dh5.foo'.startsWith(RATCHET_PREFIX_V5)).toBe(true);
    expect('x3dh4.foo'.startsWith(RATCHET_PREFIX_V4)).toBe(true);
    expect('x3dh3.foo'.startsWith(RATCHET_PREFIX_V5)).toBe(false);
    expect('x3dh3.foo'.startsWith(RATCHET_PREFIX_V4)).toBe(false);
  });
});
