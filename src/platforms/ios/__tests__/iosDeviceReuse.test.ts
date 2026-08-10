import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ios: true,
  anchor: null as string | null,
  current: null as string | null,
  identities: new Set<string>(),
  kxKeys: new Set<string>(),
  adopted: [] as string[],
}));

vi.mock('@/platforms/ios/capacitorBridge', () => ({
  isIosRuntime: () => state.ios,
}));

vi.mock('@/platforms/ios/iosDeviceIdAnchor', () => ({
  readIosDeviceIdAnchor: async () => state.anchor,
}));

vi.mock('@/lib/crypto/deviceIdentity', () => ({
  loadDeviceIdentity: async (_u: string, d: string) => (state.identities.has(d) ? { publicB64: 'sig' } : null),
}));

vi.mock('@/lib/crypto/deviceKx', () => ({
  loadDeviceKxKey: async (d: string) => (state.kxKeys.has(d) ? { publicB64: 'kx' } : null),
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  peekCurrentDeviceId: () => state.current,
  setCurrentDeviceId: (id: string) => { state.adopted.push(id); state.current = id; return id; },
}));

const DEVICE_A = 'dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function load() {
  return import('@/platforms/ios/iosDeviceReuse');
}

describe('iOS device reuse', () => {
  beforeEach(() => {
    state.ios = true;
    state.anchor = null;
    state.current = null;
    state.identities = new Set();
    state.kxKeys = new Set();
    state.adopted = [];
    vi.resetModules();
  });

  it('reuses the anchored device when the local identity still exists', async () => {
    state.anchor = DEVICE_A;
    state.identities.add(DEVICE_A);
    state.kxKeys.add(DEVICE_A);

    const mod = await load();
    await expect(mod.resolveReusableIosDevice('user-1')).resolves.toEqual({
      deviceId: DEVICE_A,
      source: 'keychain-anchor',
    });
    await expect(mod.adoptReusableIosDevice('user-1')).resolves.toBe(DEVICE_A);
    expect(state.adopted).toEqual([DEVICE_A]);
  });

  it('requires a real enrollment when no local identity exists', async () => {
    state.anchor = DEVICE_A;

    const mod = await load();
    await expect(mod.resolveReusableIosDevice('user-1')).resolves.toBeNull();
    await expect(mod.adoptReusableIosDevice('user-1')).resolves.toBeNull();
    expect(state.adopted).toEqual([]);
  });

  it('requires enrollment when only the KX key is missing (partial identity)', async () => {
    state.anchor = DEVICE_A;
    state.identities.add(DEVICE_A);

    const mod = await load();
    await expect(mod.resolveReusableIosDevice('user-1')).resolves.toBeNull();
  });

  it('keeps the already-current device without re-adopting it', async () => {
    state.current = DEVICE_A;
    state.identities.add(DEVICE_A);
    state.kxKeys.add(DEVICE_A);

    const mod = await load();
    await expect(mod.adoptReusableIosDevice('user-1')).resolves.toBe(DEVICE_A);
    expect(state.adopted).toEqual([]);
  });

  it('is a strict no-op outside iOS so Windows enrollment is untouched', async () => {
    state.ios = false;
    state.anchor = DEVICE_A;
    state.identities.add(DEVICE_A);
    state.kxKeys.add(DEVICE_A);

    const mod = await load();
    await expect(mod.resolveReusableIosDevice('user-1')).resolves.toBeNull();
    await expect(mod.adoptReusableIosDevice('user-1')).resolves.toBeNull();
  });
});
