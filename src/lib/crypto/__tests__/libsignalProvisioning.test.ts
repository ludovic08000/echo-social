import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBundle: vi.fn(),
  createStore: vi.fn(),
  captureStore: vi.fn(),
  rpc: vi.fn(),
  loadSigning: vi.fn(),
  signBundle: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (name: string, ...args: unknown[]) => {
    const request = mocks.rpc(name, ...args);
    return { abortSignal: async (signal: AbortSignal) => {
      const result = await request.abortSignal(signal);
      if (name === 'get_libsignal_prekey_inventory' && typeof result.data !== 'object') {
        return { ...result, data: { total: result.data, verified: result.data } };
      }
      return result;
    } };
  } },
}));
vi.mock('../deviceIdentity', () => ({ loadDeviceIdentity: (...args: unknown[]) => mocks.loadSigning(...args) }));
vi.mock('../libsignalBundleBinding', async (original) => ({
  ...await original<typeof import('../libsignalBundleBinding')>(),
  signLibsignalBundleBinding: (...args: unknown[]) => mocks.signBundle(...args),
}));
vi.mock('@/lib/crypto/libsignalPlatformBridge', () => ({
  captureLibsignalStore: (...args: unknown[]) => mocks.captureStore(...args),
  createLibsignalBundle: (...args: unknown[]) => mocks.createBundle(...args),
  createLibsignalStore: (...args: unknown[]) => mocks.createStore(...args),
}));
import {
  __libsignalProvisioningTest,
  maintainLibsignalDevice,
  provisionLibsignalDevice,
} from '@/lib/crypto/libsignalProvisioning';
import { __libsignalDeviceNumberTest } from '@/lib/crypto/libsignalDeviceNumber';

function bundleBytes(args: { deviceNumber: number; preKeyId: number; signedPreKeyId: number; kyberPreKeyId: number }): Uint8Array {
  const bytes = new Uint8Array(86);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20, true);
  view.setUint32(4, 42, true);
  view.setUint32(8,args.deviceNumber,true);
  view.setUint32(12,args.preKeyId,true);
  view.setUint32(16,args.signedPreKeyId,true);
  view.setUint32(20,args.kyberPreKeyId,true);
  view.setUint32(24,33,true); bytes[28]=5;
  for (let i=61;i<86;i+=5) { view.setUint32(i,1,true); bytes[i+4]=1; }
  return bytes;
}

describe('libsignal device provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __libsignalProvisioningTest.reset();
    __libsignalDeviceNumberTest.reset();
    mocks.createStore.mockResolvedValue(undefined);
    mocks.captureStore.mockResolvedValue('sealed-private-store');
    mocks.createBundle.mockImplementation(async (args) => bundleBytes(args));
    mocks.loadSigning.mockResolvedValue({ privateKey: 'existing-device-private-key' });
    mocks.signBundle.mockResolvedValue('s'.repeat(88));
  });

  it('publishes missing public bundles with at most four requests in flight', async () => {
    let activePublishes = 0;
    let maxActivePublishes = 0;
    let releasePublish: (() => void) | null = null;
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });

    mocks.rpc.mockImplementation((name: string) => ({
      abortSignal: async () => {
        if (name === 'get_libsignal_device_number') return { data: 1, error: null };
        if (name === 'get_libsignal_prekey_inventory') return { data: 0, error: null };
        activePublishes += 1;
        maxActivePublishes = Math.max(maxActivePublishes, activePublishes);
        await publishGate;
        activePublishes -= 1;
        return { data: { ok: true }, error: null };
      },
    }));

    const provisioning = provisionLibsignalDevice('user-id', `dev_${'a'.repeat(32)}`);
    await vi.waitFor(() => expect(maxActivePublishes).toBe(4));
    releasePublish?.();
    await provisioning;

    expect(mocks.createBundle).toHaveBeenCalledTimes(20);
    expect(mocks.rpc).toHaveBeenCalledTimes(22);
    expect(maxActivePublishes).toBe(4);
  });

  it('does not generate more bundles when at least half remain available', async () => {
    mocks.rpc.mockImplementation((name: string) => ({
      abortSignal: async () => name === 'get_libsignal_device_number'
        ? { data: 1, error: null }
        : { data: 10, error: null },
    }));

    await provisionLibsignalDevice('user-id', `dev_${'b'.repeat(32)}`);

    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.captureStore).toHaveBeenCalledWith('user-id', `dev_${'b'.repeat(32)}`);
    expect(mocks.createBundle).not.toHaveBeenCalled();
  });

  it('keeps successful prekey maintenance out of the hot send window', async () => {
    mocks.rpc.mockImplementation((name: string) => ({
      abortSignal: async () => name === 'get_libsignal_device_number'
        ? { data: 1, error: null }
        : { data: 10, error: null },
    }));

    await maintainLibsignalDevice('user-id', 'device-id');
    const callsAfterFirstMaintenance = mocks.rpc.mock.calls.length;
    await maintainLibsignalDevice('user-id', 'device-id');

    expect(callsAfterFirstMaintenance).toBe(2);
    expect(mocks.rpc).toHaveBeenCalledTimes(callsAfterFirstMaintenance);
  });

  it('rechecks within five minutes and replenishes the same private identity', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let remaining = 20;
      mocks.rpc.mockImplementation((name: string) => ({ abortSignal: async () => ({
        data: name === 'get_libsignal_device_number' ? 1 : name === 'get_libsignal_prekey_inventory' ? remaining : { ok: true },
        error: null,
      }) }));
      await maintainLibsignalDevice('user-id', 'device-id');
      expect(mocks.captureStore).toHaveBeenCalledTimes(1);
      remaining = 3;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await maintainLibsignalDevice('user-id', 'device-id');
      expect(mocks.captureStore).toHaveBeenCalledTimes(2);
      expect(mocks.createBundle).toHaveBeenCalledTimes(17);
    } finally { vi.useRealTimers(); }
  });

  it('backs off failed maintenance, then retries without waiting for a successful-window TTL', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      mocks.rpc.mockImplementation(() => ({ abortSignal: async () => { throw new Error('offline'); } }));
      await expect(maintainLibsignalDevice('user-id', 'device-id')).rejects.toThrow('offline');
      await maintainLibsignalDevice('user-id', 'device-id');
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(maintainLibsignalDevice('user-id', 'device-id')).rejects.toThrow('offline');
      expect(mocks.rpc).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('stops before publishing if private store persistence fails', async () => {
    mocks.rpc.mockImplementation((name: string) => ({
      abortSignal: async () => ({ data: name === 'get_libsignal_device_number' ? 1 : 0, error: null }),
    }));
    mocks.createStore.mockRejectedValue(new Error('AEGIS_LIBSIGNAL_STORE_COMMIT_FAILED'));
    await expect(provisionLibsignalDevice('user-id', 'device-id')).rejects.toThrow('STORE_COMMIT_FAILED');
    expect(mocks.createBundle).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([1, 10, 20])('requires recovery when %i public bundles outlive the private store', async (count) => {
    mocks.rpc.mockImplementation((name: string) => ({
      abortSignal: async () => ({ data: name === 'get_libsignal_device_number' ? 1
        : name === 'publish_libsignal_prekey_bundle' ? { ok: true } : count, error: null }),
    }));
    mocks.captureStore.mockRejectedValueOnce(new Error('AEGIS_LIBSIGNAL_STORE_MISSING'));
    await expect(provisionLibsignalDevice('user-id', 'device-id')).rejects.toThrow('STORE_MISSING');
    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.createBundle).not.toHaveBeenCalled();
    // Après restauration réelle du coffre, une nouvelle tentative peut réussir.
    await provisionLibsignalDevice('user-id', 'device-id');
    expect(mocks.captureStore).toHaveBeenCalledTimes(2);
  });

  it('coalesces simultaneous lifecycle triggers for the same device', async () => {
    mocks.rpc.mockImplementation((name: string) => ({
      abortSignal: async () => ({ data: name === 'get_libsignal_device_number' ? 1
        : name === 'publish_libsignal_prekey_bundle' ? { ok: true } : 0, error: null }),
    }));
    const first = provisionLibsignalDevice('user-id', 'device-id');
    const second = provisionLibsignalDevice('user-id', 'device-id');
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mocks.createBundle).toHaveBeenCalledTimes(20);
    expect(mocks.createStore).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 1.5, 'invalid'])('rejects invalid server bundle count %s', async (count) => {
    mocks.rpc.mockImplementation((name: string) => ({
      abortSignal: async () => ({ data: name === 'get_libsignal_device_number' ? 1 : count, error: null }),
    }));
    await expect(provisionLibsignalDevice('user-id', 'device-id')).rejects.toThrow('BUNDLE_COUNT_INVALID');
    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.createBundle).not.toHaveBeenCalled();
  });

  it('does not recreate a lost store when only unsigned pre-upgrade stock remains', async () => {
    mocks.rpc.mockImplementation((name: string) => ({ abortSignal: async () => ({
      data: name==='get_libsignal_device_number' ? 1 : { total:20,verified:0 }, error:null,
    }) }));
    mocks.captureStore.mockRejectedValueOnce(new Error('AEGIS_LIBSIGNAL_STORE_MISSING'));
    await expect(provisionLibsignalDevice('user-id','device-id')).rejects.toThrow('STORE_MISSING');
    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.createBundle).not.toHaveBeenCalled();
  });
  it('stops before store creation when the approved signing private key is absent', async () => {
    mocks.rpc.mockImplementation((name: string) => ({ abortSignal: async () => ({
      data: name==='get_libsignal_device_number' ? 1 : { total:0,verified:0 }, error:null,
    }) }));
    mocks.loadSigning.mockResolvedValueOnce(null);
    await expect(provisionLibsignalDevice('user-id','device-id')).rejects.toThrow('SIGNING_KEY_MISSING');
    expect(mocks.createStore).not.toHaveBeenCalled();
  });
});
