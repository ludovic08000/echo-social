import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceDescriptor } from '@/e2ee-session/types';

const mocks = vi.hoisted(() => ({
  invalidateVerifiedDeviceCache: vi.fn(),
}));

vi.mock('@/e2ee-session/deviceRegistry', () => ({
  listFanoutTargets: vi.fn(async () => []),
  invalidateVerifiedDeviceCache: mocks.invalidateVerifiedDeviceCache,
}));

import { __test__, invalidateFanoutRoute } from '../fanoutRouteCache';

const TARGETS: DeviceDescriptor[] = [{
  userId: 'user-b',
  deviceId: 'device-b-12345678',
  devicePublicKey: 'public-key-b',
}];

describe('fanoutRouteCache', () => {
  beforeEach(() => {
    __test__.reset();
    vi.clearAllMocks();
  });

  it('coalesces and reuses a route inside the ttl', async () => {
    const loader = vi.fn(async () => TARGETS);
    const now = 1_000;

    const [first, second] = await Promise.all([
      __test__.resolveCachedRoute('route-a', loader, now),
      __test__.resolveCachedRoute('route-a', loader, now),
    ]);
    const third = await __test__.resolveCachedRoute('route-a', loader, now + 1_000);

    expect(first).toEqual(TARGETS);
    expect(second).toEqual(TARGETS);
    expect(third).toEqual(TARGETS);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(__test__.size()).toBe(1);
  });

  it('reloads the route after the ttl', async () => {
    const loader = vi.fn(async () => TARGETS);
    const now = 10_000;

    await __test__.resolveCachedRoute('route-b', loader, now);
    await __test__.resolveCachedRoute('route-b', loader, now + __test__.ttlMs + 1);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected network resolution', async () => {
    const loader = vi
      .fn<() => Promise<DeviceDescriptor[]>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(TARGETS);

    await expect(__test__.resolveCachedRoute('route-c', loader, 0)).rejects.toThrow('network');
    await expect(__test__.resolveCachedRoute('route-c', loader, 1)).resolves.toEqual(TARGETS);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidates the signed device cache before a stale-route rebuild', () => {
    invalidateFanoutRoute('conversation-a', 'sender-a');

    expect(mocks.invalidateVerifiedDeviceCache).toHaveBeenCalledTimes(1);
  });
});
