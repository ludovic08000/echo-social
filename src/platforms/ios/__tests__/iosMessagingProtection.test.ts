import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ios: true,
  identity: null as null | { publicB64: string; privateKey: CryptoKey },
  kx: null as null | { publicB64: string; privateKey: CryptoKey },
  serverSpk: null as null | { spk_id: number; public_key: string },
  serverOpks: [] as Array<{ opk_id: number; public_key: string }>,
  localPrekeys: [] as Array<{ id: string; spkId: number; privateKeyJWK: JsonWebKey; publicKeyBase64: string; createdAt: number }>,
}));

vi.mock('@/platforms/ios/iosRuntime', () => ({
  isIosWebRuntime: () => state.ios,
}));

vi.mock('@/lib/crypto/deviceIdentity', () => ({
  loadDeviceIdentity: vi.fn(async () => state.identity),
}));

vi.mock('@/lib/crypto/deviceKx', () => ({
  loadDeviceKxKey: vi.fn(async () => state.kx),
}));

vi.mock('@/lib/crypto/devicePrekeyRepair', () => ({
  repairCurrentDevicePrekeys: vi.fn(async () => ({ repaired: true, reason: 'test' })),
}));

vi.mock('@/lib/crypto/indexedDbTx', () => ({
  runTxOn: vi.fn(async (dbName: string) => dbName === 'spk' ? state.localPrekeys : undefined),
  reqToPromise: vi.fn(),
}));

vi.mock('@/lib/messaging/aegisDeviceRuntime', () => ({ invalidateAegisDeviceRuntime: vi.fn() }));
vi.mock('@/lib/messaging/fanoutRouteCache', () => ({ invalidateAllFanoutRoutes: vi.fn() }));
vi.mock('@/lib/messaging/multiDeviceFanout', () => ({ clearDeviceCopyCache: vi.fn() }));

function builderFor(table: string) {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.order = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => ({ data: state.serverSpk, error: null }));
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(
    table === 'device_one_time_prekeys'
      ? { data: state.serverOpks, error: null }
      : { data: null, error: null },
  ).then(resolve, reject);
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((table: string) => builderFor(table)),
  },
}));

import { inspectIosMessagingIntegrity } from '@/platforms/ios/iosMessagingProtection';

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const readyRecord = {
  deviceId: DEVICE,
  deviceRole: 'secondary' as const,
  lifecycleStatus: 'ready' as const,
  approvalStatus: 'approved' as const,
  bindingStatus: 'bound' as const,
  routingStatus: 'ready' as const,
  isActive: true,
  revokedAt: null,
  deviceName: 'iPhone',
  platform: 'ios',
  devicePublicKey: 'kx-server',
  deviceSigningKey: 'sig-server',
  approvalChallengeId: null,
  approvedByDeviceId: null,
};

function localRecord(id: string, spkId: number, publicKeyBase64: string) {
  return {
    id,
    spkId,
    privateKeyJWK: { kty: 'OKP', crv: 'X25519', x: 'x'.repeat(43), d: 'd'.repeat(43) },
    publicKeyBase64,
    createdAt: Date.now(),
  };
}

describe('iOS messaging protection integrity', () => {
  beforeEach(() => {
    state.ios = true;
    state.identity = { publicB64: 'sig-server', privateKey: {} as CryptoKey };
    state.kx = { publicB64: 'kx-server', privateKey: {} as CryptoKey };
    state.serverSpk = { spk_id: 7, public_key: 'spk-server' };
    state.serverOpks = [{ opk_id: 9, public_key: 'opk-server' }];
    state.localPrekeys = [
      localRecord(`${USER}::dev::${DEVICE}::7`, 7, 'spk-server'),
      localRecord(`${USER}::dev::${DEVICE}::opk::9`, 9, 'opk-server'),
    ];
  });

  it('is a strict no-op outside iOS so Windows behavior stays unchanged', async () => {
    state.ios = false;
    const report = await inspectIosMessagingIntegrity(USER, readyRecord);
    expect(report.issue).toBe('none');
    expect(report.signingKeyMatches).toBe(true);
    expect(report.kxKeyMatches).toBe(true);
  });

  it('blocks when the local X25519 key no longer matches the approved server device', async () => {
    state.kx = { publicB64: 'kx-local-different', privateKey: {} as CryptoKey };
    const report = await inspectIosMessagingIntegrity(USER, readyRecord);
    expect(report.issue).toBe('local-device-key-mismatch');
    expect(report.signingKeyMatches).toBe(true);
    expect(report.kxKeyMatches).toBe(false);
    expect(report.repairablePrekeys).toBe(false);
  });

  it('detects server-advertised SPK/OPK whose private material disappeared from Safari', async () => {
    state.localPrekeys = [];
    const report = await inspectIosMessagingIntegrity(USER, readyRecord);
    expect(report.issue).toBe('local-prekeys-missing');
    expect(report.repairablePrekeys).toBe(true);
    expect(report.spkMatches).toBe(false);
    expect(report.opksMatch).toBe(false);
  });

  it('accepts a ready iOS device only when device keys and all advertised prekeys match locally', async () => {
    const report = await inspectIosMessagingIntegrity(USER, readyRecord);
    expect(report.issue).toBe('none');
    expect(report.spkMatches).toBe(true);
    expect(report.opksMatch).toBe(true);
    expect(report.serverOpkCount).toBe(1);
    expect(report.localOpkCount).toBe(1);
  });
});
