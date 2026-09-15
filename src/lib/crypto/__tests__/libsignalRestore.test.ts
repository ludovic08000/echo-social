import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: false,
  records: new Map<string, { bytes: string }>(),
  read: vi.fn(), write: vi.fn(), lock: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => ({}),
}));
vi.mock('@/lib/runtimePlatform', () => ({ isVerifiedNativeRuntime: () => mocks.native }));
vi.mock('../deviceVault', () => ({ readDeviceVaultRecord: mocks.read, writeDeviceVaultRecord: mocks.write }));
vi.mock('../libsignalStoreLock', () => ({ withLibsignalStoreLock: mocks.lock }));
vi.mock('@/lib/device-manager/deviceFinalizationTrace', () => ({
  traceFinalizationOperation: (_name: string, work: () => unknown) => work(),
}));
import { hasLibsignalStore, restoreLibsignalStore } from '../libsignalPlatformBridge';

describe.each([false, true])('Libsignal restoration (native=%s)', native => {
  const id = 'aegis.libsignal.store:alice:phone';
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.records.clear();
    mocks.native = native;
    mocks.read.mockImplementation(async (key: string) => mocks.records.get(key) ?? null);
    mocks.write.mockImplementation(async (key: string, record: { bytes: string }) => { mocks.records.set(key, record); });
    mocks.lock.mockImplementation(async (_user: string, _device: string, work: () => unknown) => work());
  });
  it('restores a missing store with a durable readback under the device lock', async () => {
    await restoreLibsignalStore('alice', 'phone', 'AQID');
    expect(mocks.records.get(id)).toEqual({ bytes: 'AQID' });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.lock).toHaveBeenCalledWith('alice', 'phone', expect.any(Function));
  });
  it('distinguishes an absent store from an unreadable vault', async () => {
    await expect(hasLibsignalStore('alice', 'phone')).resolves.toBe(false);
    mocks.read.mockRejectedValueOnce(new Error('vault locked'));
    await expect(hasLibsignalStore('alice', 'phone')).rejects.toThrow('vault locked');
    mocks.records.set(id, { bytes: 'AQID' });
    await expect(hasLibsignalStore('alice', 'phone')).resolves.toBe(true);
  });
  it('is idempotent without writing an identical store again', async () => {
    mocks.records.set(id, { bytes: 'AQID' });
    await restoreLibsignalStore('alice', 'phone', 'AQID');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('never overwrites an advanced store with a backup', async () => {
    mocks.records.set(id, { bytes: 'BAUG' });
    await expect(restoreLibsignalStore('alice', 'phone', 'AQID')).rejects.toThrow('RESTORE_CONFLICT');
    expect(mocks.records.get(id)).toEqual({ bytes: 'BAUG' });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('does not treat a vault read failure as a missing store', async () => {
    mocks.read.mockRejectedValueOnce(new Error('vault locked'));
    await expect(restoreLibsignalStore('alice', 'phone', 'AQID')).rejects.toThrow('vault locked');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('does not report success when readback fails', async () => {
    mocks.read.mockResolvedValue(null);
    await expect(restoreLibsignalStore('alice', 'phone', 'AQID')).rejects.toThrow('STORE_COMMIT_FAILED');
  });
});
