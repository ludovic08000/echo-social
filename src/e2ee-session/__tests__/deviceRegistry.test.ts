import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
  logCryptoError: vi.fn(),
  getDeviceCryptoInvalid: vi.fn(),
  requestDevicePrekeyRepair: vi.fn(),
  lifecycle: new Map<string, any>(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
  },
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  peekDeviceSignedPrekey: mocks.peekDeviceSignedPrekey,
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: mocks.logCryptoError,
}));

vi.mock('@/lib/messaging/deviceCryptoInvalid', () => ({
  getDeviceCryptoInvalid: mocks.getDeviceCryptoInvalid,
  requestDevicePrekeyRepair: mocks.requestDevicePrekeyRepair,
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'self-device',
  isDeviceIdTemporary: () => false,
}));

import { isDeviceStale, listDevicesForUser } from '../deviceRegistry';

function makeUserDevicesBuilder() {
  const filters: Record<string, string> = {};
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((field: string, value: string) => {
      filters[field] = value;
      return builder;
    }),
    maybeSingle: vi.fn(async () => ({
      data: mocks.lifecycle.get(filters.device_id) ?? null,
      error: null,
    })),
  };
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lifecycle.clear();
  mocks.from.mockImplementation(() => makeUserDevicesBuilder());
  mocks.peekDeviceSignedPrekey.mockResolvedValue({ signedPrekeyId: 1 });
  mocks.getDeviceCryptoInvalid.mockReturnValue(null);
  mocks.requestDevicePrekeyRepair.mockResolvedValue(true);
});

describe('deviceRegistry hygiene', () => {
  it('marks revoked, inactive, stale, invalid-signature, and SPK-less devices as stale', () => {
    const now = Date.now();
    expect(isDeviceStale({ userId: 'u', deviceId: 'd', devicePublicKey: 'k', revokedAt: now })).toBe(true);
    expect(isDeviceStale({ userId: 'u', deviceId: 'd', devicePublicKey: 'k', isActive: false })).toBe(true);
    expect(isDeviceStale({ userId: 'u', deviceId: 'd', devicePublicKey: 'k', lastSeen: now - 46 * 24 * 60 * 60 * 1000 }, now)).toBe(true);
    expect(isDeviceStale({ userId: 'u', deviceId: 'd', devicePublicKey: 'k', signatureInvalid: true })).toBe(true);
    expect(isDeviceStale({ userId: 'u', deviceId: 'd', devicePublicKey: 'k', hasActiveSignedPrekey: false })).toBe(true);
  });

  it('dedupes by recent last_seen and filters revoked/stale/SPK-less devices', async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    mocks.rpc.mockResolvedValue({
      data: [
        { device_id: 'd1', device_public_key: 'old', last_seen_at: iso(now - 2 * 24 * 60 * 60 * 1000) },
        { device_id: 'd1', device_public_key: 'new', last_seen_at: iso(now - 60_000) },
        { device_id: 'd2', device_public_key: 'revoked', last_seen_at: iso(now - 60_000) },
        { device_id: 'd3', device_public_key: 'old-stale', last_seen_at: iso(now - 46 * 24 * 60 * 60 * 1000) },
        { device_id: 'd4', device_public_key: 'no-spk', last_seen_at: iso(now - 60_000) },
        { device_id: 'd5', device_public_key: 'active', last_seen_at: iso(now - 120_000) },
      ],
      error: null,
    });

    mocks.lifecycle.set('d1', { device_id: 'd1', device_public_key: 'new', is_active: true, revoked_at: null, stale_at: null, last_seen_at: iso(now - 60_000) });
    mocks.lifecycle.set('d2', { device_id: 'd2', device_public_key: 'revoked', is_active: false, revoked_at: iso(now), stale_at: null, last_seen_at: iso(now - 60_000) });
    mocks.lifecycle.set('d3', { device_id: 'd3', device_public_key: 'old-stale', is_active: true, revoked_at: null, stale_at: null, last_seen_at: iso(now - 46 * 24 * 60 * 60 * 1000) });
    mocks.lifecycle.set('d4', { device_id: 'd4', device_public_key: 'no-spk', is_active: true, revoked_at: null, stale_at: null, last_seen_at: iso(now - 60_000) });
    mocks.lifecycle.set('d5', { device_id: 'd5', device_public_key: 'active', is_active: true, revoked_at: null, stale_at: null, last_seen_at: iso(now - 120_000) });
    mocks.peekDeviceSignedPrekey.mockImplementation(async (_userId: string, deviceId: string) => (
      deviceId === 'd4' ? null : { signedPrekeyId: 1 }
    ));

    const devices = await listDevicesForUser('user-1');

    expect(devices.map(d => [d.deviceId, d.devicePublicKey])).toEqual([
      ['d1', 'new'],
      ['d5', 'active'],
    ]);
    expect(mocks.peekDeviceSignedPrekey).not.toHaveBeenCalledWith('user-1', 'd2');
    expect(mocks.logCryptoError).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'E_SKIP_STALE_DEVICE',
    }));
  });

  it('skips locally crypto-invalid devices without re-peeking their SPK', async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    mocks.rpc.mockResolvedValue({
      data: [
        { device_id: 'd-invalid', device_public_key: 'pub', last_seen_at: iso(now - 60_000) },
      ],
      error: null,
    });
    mocks.lifecycle.set('d-invalid', {
      device_id: 'd-invalid',
      device_public_key: 'pub',
      is_active: true,
      revoked_at: null,
      stale_at: null,
      last_seen_at: iso(now - 60_000),
    });
    mocks.getDeviceCryptoInvalid.mockReturnValue({
      userId: 'user-1',
      deviceId: 'd-invalid',
      reason: 'invalid_spk_signature',
      markedAt: now,
      expiresAt: now + 60_000,
    });

    const devices = await listDevicesForUser('user-1');

    expect(devices).toEqual([]);
    expect(mocks.peekDeviceSignedPrekey).not.toHaveBeenCalled();
    expect(mocks.requestDevicePrekeyRepair).toHaveBeenCalledWith(
      'user-1',
      'd-invalid',
      'invalid_spk_signature',
    );
  });
});
