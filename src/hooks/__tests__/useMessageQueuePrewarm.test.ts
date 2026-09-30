import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  ensureDeviceReady: vi.fn(),
  warmRoute: vi.fn(),
  warmDeviceNumbers: vi.fn(),
  prewarmStore: vi.fn(),
  maintainDevice: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getSession: mocks.getSession },
  },
}));

vi.mock('@/lib/messaging/aegisDeviceRuntime', () => ({
  ensureAegisDeviceReady: mocks.ensureDeviceReady,
}));

vi.mock('@/lib/messaging/fanoutRouteCache', () => ({
  warmFanoutRoute: mocks.warmRoute,
}));

vi.mock('@/lib/crypto/libsignalDeviceNumber', () => ({
  warmLibsignalDeviceNumbers: mocks.warmDeviceNumbers,
}));

vi.mock('@/lib/crypto/libsignalPlatformBridge', () => ({
  prewarmLibsignalStore: mocks.prewarmStore,
}));

vi.mock('@/lib/crypto/libsignalProvisioning', () => ({
  maintainLibsignalDevice: mocks.maintainDevice,
}));

vi.mock('@/lib/messaging/e2eeTrace', () => ({
  traceE2EEBlock: vi.fn((_event: unknown, operation: () => Promise<unknown>) => operation()),
}));

import {
  __prewarmTest,
  prewarmAegisSendPath,
} from '@/hooks/useMessageQueue';

describe('Aegis send-path prewarm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __prewarmTest.reset();
    mocks.getSession.mockResolvedValue({ data: { session: {} }, error: null });
    mocks.ensureDeviceReady.mockResolvedValue({
      deviceId: 'device-stable',
      userId: 'user-one',
    });
    mocks.warmRoute.mockResolvedValue({
      version: 'route-one',
      targets: [{
        userId: 'user-two',
        deviceId: 'device-remote',
        devicePublicKey: 'public-key',
      }],
    });
    mocks.warmDeviceNumbers.mockResolvedValue(undefined);
    mocks.prewarmStore.mockResolvedValue(undefined);
    mocks.maintainDevice.mockResolvedValue(undefined);
  });

  it('waits for a stable device before warming the canonical route', async () => {
    let releaseDevice!: (value: { deviceId: string; userId: string }) => void;
    mocks.ensureDeviceReady.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDevice = resolve;
    }));

    const prewarm = prewarmAegisSendPath('user-one', 'conversation-one');
    await Promise.resolve();

    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureDeviceReady).toHaveBeenCalledTimes(1);
    expect(mocks.warmRoute).not.toHaveBeenCalled();

    releaseDevice({ deviceId: 'device-stable', userId: 'user-one' });
    await prewarm;

    expect(mocks.warmRoute).toHaveBeenCalledWith('conversation-one', 'user-one');
    expect(mocks.prewarmStore).toHaveBeenCalledWith('user-one', 'device-stable');
    expect(mocks.maintainDevice).toHaveBeenCalledWith('user-one', 'device-stable');
    expect(mocks.warmDeviceNumbers).toHaveBeenCalledWith([
      { userId: 'user-one', deviceId: 'device-stable' },
      { userId: 'user-two', deviceId: 'device-remote' },
    ]);
  });

  it('coalesces concurrent warmups and reuses a fresh route window', async () => {
    const first = prewarmAegisSendPath('user-one', 'conversation-one');
    const second = prewarmAegisSendPath('user-one', 'conversation-one');

    expect(second).toBe(first);
    await Promise.all([first, second]);
    await prewarmAegisSendPath('user-one', 'conversation-one');

    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureDeviceReady).toHaveBeenCalledTimes(1);
    expect(mocks.warmRoute).toHaveBeenCalledTimes(1);
    expect(mocks.prewarmStore).toHaveBeenCalledTimes(1);
    expect(mocks.maintainDevice).toHaveBeenCalledTimes(1);
    expect(mocks.warmDeviceNumbers).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed route warmup', async () => {
    let now = 100_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.warmRoute
      .mockRejectedValueOnce(new Error('route unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(prewarmAegisSendPath('user-one', 'conversation-one'))
      .rejects.toThrow('route unavailable');
    await expect(prewarmAegisSendPath('user-one', 'conversation-one'))
      .resolves.toBeUndefined();
    expect(mocks.warmRoute).toHaveBeenCalledTimes(1);

    now += __prewarmTest.retryMs + 1;
    await expect(prewarmAegisSendPath('user-one', 'conversation-one'))
      .resolves.toBeUndefined();

    expect(mocks.warmRoute).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });
});
