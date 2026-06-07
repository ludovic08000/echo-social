import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'dev-current',
  hydrateDeviceId: vi.fn(async () => 'dev-current'),
}));

vi.mock('../keyManager', () => ({
  getOrCreateIdentityKeys: vi.fn(async () => ({ signingPrivateKey: {} })),
}));

vi.mock('../x3dh', () => ({
  refreshSignedPrekeyIfNeeded: vi.fn(async () => undefined),
  refreshDeviceSignedPrekeyIfNeeded: vi.fn(async () => undefined),
  refillDeviceOneTimePrekeysIfNeeded: vi.fn(async () => undefined),
}));

vi.mock('../devicePrekeyRepair', () => ({
  repairCurrentDevicePrekeys: vi.fn(async () => undefined),
}));

import { runPostRestoreLifecycle } from '../postRestoreLifecycle';

function chainFor(table: unknown) {
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => {
      if (table === 'user_devices') return { data: { device_public_key: 'device-pub' }, error: null };
      return { data: null, error: null };
    }),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ data: 7, error: null });
  fromMock.mockImplementation(chainFor);
});

describe('runPostRestoreLifecycle', () => {
  it('bumps the current device SPK epoch instead of touching user_public_keys', async () => {
    const result = await runPostRestoreLifecycle('user-1', 'pin');

    expect(result).toEqual({ ok: true, deviceId: 'dev-current', keysEpoch: 7 });
    expect(rpcMock).toHaveBeenCalledWith('bump_device_keys_epoch', {
      p_user_id: 'user-1',
      p_device_id: 'dev-current',
    });
    expect(rpcMock).not.toHaveBeenCalledWith('bump_keys_epoch', expect.anything());
    expect(fromMock).not.toHaveBeenCalledWith('user_public_keys');
  });
});
