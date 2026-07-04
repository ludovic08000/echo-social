import { describe, it, expect } from 'vitest';
import { resolveSigningKeyForEnvelope, type DeviceSigningKeyMap } from '@/lib/crypto/peerDeviceSigningKeys';

describe('resolveSigningKeyForEnvelope', () => {
  const deviceKey = 'DEVICE_SIGNING_KEY_B64';
  const accountKey = 'ACCOUNT_SIGNING_KEY_B64';

  it('uses the sending device key when the fingerprint is known', () => {
    const map: DeviceSigningKeyMap = new Map([['fp-secondary-device', deviceKey]]);
    const res = resolveSigningKeyForEnvelope(map, 'fp-secondary-device', accountKey);
    expect(res.signingKeyB64).toBe(deviceKey);
    expect(res.source).toBe('device');
  });

  it('falls back to the account key when the device is unknown', () => {
    const map: DeviceSigningKeyMap = new Map([['fp-other', deviceKey]]);
    const res = resolveSigningKeyForEnvelope(map, 'fp-unlisted', accountKey);
    expect(res.signingKeyB64).toBe(accountKey);
    expect(res.source).toBe('fallback');
  });

  it('falls back when the map is empty (backend not yet publishing per-device keys)', () => {
    const res = resolveSigningKeyForEnvelope(new Map(), 'fp-any', accountKey);
    expect(res.signingKeyB64).toBe(accountKey);
    expect(res.source).toBe('fallback');
  });

  it('falls back when the map is null', () => {
    const res = resolveSigningKeyForEnvelope(null, 'fp-any', accountKey);
    expect(res.signingKeyB64).toBe(accountKey);
    expect(res.source).toBe('fallback');
  });

  it('falls back when the envelope carries no fingerprint', () => {
    const map: DeviceSigningKeyMap = new Map([['fp-x', deviceKey]]);
    const res = resolveSigningKeyForEnvelope(map, undefined, accountKey);
    expect(res.signingKeyB64).toBe(accountKey);
    expect(res.source).toBe('fallback');
  });

  it('reports source "none" when neither a device key nor a fallback exists', () => {
    const res = resolveSigningKeyForEnvelope(new Map(), 'fp-any', undefined);
    expect(res.signingKeyB64).toBeUndefined();
    expect(res.source).toBe('none');
  });

  it('ignores an empty-string device key and falls back', () => {
    const map: DeviceSigningKeyMap = new Map([['fp-empty', '']]);
    const res = resolveSigningKeyForEnvelope(map, 'fp-empty', accountKey);
    expect(res.signingKeyB64).toBe(accountKey);
    expect(res.source).toBe('fallback');
  });
});
