import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ state: vi.fn(), prepare: vi.fn(), hasStore: vi.fn(), unlocked: vi.fn() }));
vi.mock('../deviceApi', () => ({ deviceApi: { getState: mocks.state, prepareKeys: mocks.prepare } }));
vi.mock('@/lib/crypto/libsignalPlatformBridge', () => ({ hasLibsignalStore: mocks.hasStore }));
vi.mock('@/lib/device-manager/pinUnlockSignal', () => ({ readPinUnlocked: mocks.unlocked }));
import { cryptoApi } from '../cryptoApi';
import { clearDeviceFinalizationTrace, getDeviceFinalizationTrace } from '@/lib/device-manager/deviceFinalizationTrace';
beforeEach(() => {
  clearDeviceFinalizationTrace();
  vi.resetAllMocks();
  mocks.unlocked.mockReturnValue(true);
  mocks.state.mockResolvedValue({ state: 'ready', record: { deviceId: 'device' } });
  mocks.hasStore.mockResolvedValue(true);
});
it('recovers missing local Libsignal state even if the server route is READY', async () => {
  mocks.hasStore.mockResolvedValueOnce(false);
  await expect(cryptoApi.ensureReady('alice')).resolves.toMatchObject({ state: 'ready' });
  expect(mocks.prepare).toHaveBeenCalledWith('alice');
  expect(mocks.hasStore).toHaveBeenCalledTimes(2);
});
it('refuses readiness if preparation did not restore the store', async () => {
  mocks.hasStore.mockResolvedValue(false);
  await expect(cryptoApi.ensureReady('alice')).rejects.toThrow('AEGIS_LIBSIGNAL_STORE_MISSING');
});
it('does not restore over an unreadable vault', async () => {
  mocks.hasStore.mockRejectedValue(new Error('vault read failed'));
  await expect(cryptoApi.ensureReady('alice')).rejects.toThrow('vault read failed');
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('does not prepare a complete ready device again', async () => {
  await cryptoApi.ensureReady('alice');
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('does not access private state before PIN unlock', async () => {
  mocks.unlocked.mockReturnValue(false);
  await expect(cryptoApi.ensureReady('alice')).rejects.toThrow('PIN_UNLOCK_REQUIRED');
  expect(mocks.hasStore).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('reports routing ready but lifecycle syncing without pretending the runtime is ready', async () => {
  mocks.state.mockResolvedValue({ state: 'key_setup_required', record: {
    deviceId: 'device', approvalStatus: 'approved', bindingStatus: 'bound', routingStatus: 'ready', lifecycleStatus: 'syncing', isActive: true,
  } });
  await expect(cryptoApi.ensureReady('alice')).rejects.toThrow('CRYPTO_NOT_READY:key_setup_required');
  expect(getDeviceFinalizationTrace().find(e => e.step === 'crypto_readiness.device_state')).toMatchObject({
    outcome: 'failure', errorCode: 'CRYPTO_NOT_READY', state: { routingStatus: 'ready', lifecycleStatus: 'syncing' },
  });
});
