import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ios: true,
  anchored: [] as string[],
  published: [] as string[],
  publishOk: true,
}));

vi.mock('@/platforms/ios/capacitorBridge', () => ({
  isIosRuntime: () => state.ios,
}));

vi.mock('@/platforms/ios/iosDeviceIdAnchor', () => ({
  writeIosDeviceIdAnchor: async (_key: string, deviceId: string) => {
    state.anchored.push(deviceId);
    return true;
  },
}));

vi.mock('@/platforms/ios/iosPlatformMetadata', () => ({
  publishIosPlatformMetadata: async (_userId: string, deviceId: string) => {
    state.published.push(deviceId);
    return state.publishOk;
  },
}));

const DEVICE_ID = 'dev_0123456789abcdef0123456789abcdef';

async function load() {
  return import('@/platforms/ios/iosLifecycleAdapter');
}

describe('iOS lifecycle adapter', () => {
  beforeEach(() => {
    state.ios = true;
    state.anchored = [];
    state.published = [];
    state.publishOk = true;
    vi.resetModules();
  });

  it('anchors the DeviceID and publishes platform metadata once', async () => {
    const adapter = await load();
    await adapter.syncIosDeviceAdapter('user-1', DEVICE_ID);
    await adapter.syncIosDeviceAdapter('user-1', DEVICE_ID);

    expect(state.anchored).toEqual([DEVICE_ID, DEVICE_ID]);
    expect(state.published).toEqual([DEVICE_ID]);
  });

  it('retries metadata publication after a failure', async () => {
    state.publishOk = false;
    const adapter = await load();
    await adapter.syncIosDeviceAdapter('user-1', DEVICE_ID);
    state.publishOk = true;
    await adapter.syncIosDeviceAdapter('user-1', DEVICE_ID);

    expect(state.published).toEqual([DEVICE_ID, DEVICE_ID]);
  });

  it('does nothing outside iOS (Windows flow untouched)', async () => {
    state.ios = false;
    const adapter = await load();
    await adapter.syncIosDeviceAdapter('user-1', DEVICE_ID);

    expect(state.anchored).toEqual([]);
    expect(state.published).toEqual([]);
  });
});
