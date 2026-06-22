/**
 * Multi-device fan-out envelope format tests.
 *
 * New device-copy bootstraps are pinned to:
 *   x3dh5.init.v2.iv.ct.ek.spkId.opkIdOr0.senderIK.recipientIK
 *
 * The legacy x3dh5.init.iv.ct.ek.spkId[.opkId] reader is kept only for
 * already-sent messages.
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

function buildV5Bootstrap(iv: string, ct: string, ek: string, spkId: number, opkId: number | undefined, senderIK = 'IK_A', recipientIK = 'IK_B'): string {
  return [X3DH_BOOTSTRAP_PREFIX_V5 + 'v2', iv, ct, ek, String(spkId), opkId === undefined ? '0' : String(opkId), senderIK, recipientIK].join('.');
}

function buildLegacyV5Bootstrap(iv: string, ct: string, ek: string, spkId: number, opkId?: number): string {
  const fields = [X3DH_BOOTSTRAP_PREFIX_V5 + iv, ct, ek, String(spkId)];
  if (opkId !== undefined) fields.push(String(opkId));
  return fields.join('.');
}

function parseV5Bootstrap(payload: string):
  | { version: 'legacy' | 'v2'; iv: string; ct: string; ek: string; spkId: number; opkId?: number; senderIK?: string; recipientIK?: string }
  | null {
  if (!payload.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return null;
  const parts = payload.slice(X3DH_BOOTSTRAP_PREFIX_V5.length).split('.');
  if (parts[0] === 'v2') {
    if (parts.length !== 8) return null;
    const [, iv, ct, ek, spkIdStr, opkIdStr, senderIK, recipientIK] = parts;
    const spkId = parseInt(spkIdStr, 10);
    if (Number.isNaN(spkId)) return null;
    const opkId = opkIdStr === '0' ? undefined : parseInt(opkIdStr, 10);
    if (opkIdStr !== '0' && Number.isNaN(opkId as number)) return null;
    return { version: 'v2', iv, ct, ek, spkId, opkId, senderIK, recipientIK };
  }
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [iv, ct, ek, spkIdStr, opkIdStr] = parts;
  const spkId = parseInt(spkIdStr, 10);
  if (Number.isNaN(spkId)) return null;
  if (opkIdStr === undefined) return { version: 'legacy', iv, ct, ek, spkId };
  const opkId = parseInt(opkIdStr, 10);
  if (Number.isNaN(opkId)) return null;
  return { version: 'legacy', iv, ct, ek, spkId, opkId };
}

describe('multi-device fan-out bootstrap envelope v5', () => {
  it('round-trips a v2 bootstrap envelope without OPK and with sender/recipient identity keys', () => {
    const payload = buildV5Bootstrap('IVbase64', 'CTbase64', 'EKbase64', 7, undefined, 'senderIK', 'recipientIK');
    expect(parseV5Bootstrap(payload)).toEqual({
      version: 'v2',
      iv: 'IVbase64',
      ct: 'CTbase64',
      ek: 'EKbase64',
      spkId: 7,
      opkId: undefined,
      senderIK: 'senderIK',
      recipientIK: 'recipientIK',
    });
  });

  it('round-trips a v2 bootstrap envelope with OPK', () => {
    const payload = buildV5Bootstrap('IVx', 'CTx', 'EKx', 12, 99);
    expect(parseV5Bootstrap(payload)).toEqual({
      version: 'v2',
      iv: 'IVx',
      ct: 'CTx',
      ek: 'EKx',
      spkId: 12,
      opkId: 99,
      senderIK: 'IK_A',
      recipientIK: 'IK_B',
    });
  });

  it('keeps a legacy v5 bootstrap reader for already-sent messages', () => {
    expect(parseV5Bootstrap(buildLegacyV5Bootstrap('IVold', 'CTold', 'EKold', 3, 8))).toEqual({
      version: 'legacy',
      iv: 'IVold',
      ct: 'CTold',
      ek: 'EKold',
      spkId: 3,
      opkId: 8,
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
    expect(parseV5Bootstrap('x3dh5.init.v2.iv.ct.ek.notanint.0.IKA.IKB')).toBeNull();
    expect(parseV5Bootstrap('x3dh5.init.v2.iv.ct.ek.5.notanint.IKA.IKB')).toBeNull();
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
