import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBundle: vi.fn(),
  createStore: vi.fn(),
  captureStore: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => mocks.rpc(...args) },
}));
vi.mock('@/lib/crypto/libsignalPlatformBridge', () => ({
  captureLibsignalStore: (...args: unknown[]) => mocks.captureStore(...args),
  createLibsignalBundle: (...args: unknown[]) => mocks.createBundle(...args),
  createLibsignalStore: (...args: unknown[]) => mocks.createStore(...args),
}));
import { provisionLibsignalDevice } from '@/lib/crypto/libsignalProvisioning';

function bundleBytes(): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20, true);
  view.setUint32(4, 42, true);
  return bytes;
}

describe('libsignal device provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createStore.mockResolvedValue(undefined);
    mocks.captureStore.mockResolvedValue('sealed-private-store');
    mocks.createBundle.mockImplementation(async () => bundleBytes());
  });

  it('publishes missing public bundles with at most four requests in flight', async () => {
    let activePublishes = 0;
    let maxActivePublishes = 0;
    let releasePublish: (() => void) | null = null;
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });

    mocks.rpc.mockImplementation((name: string) => ({
      abortSignal: async () => {
        if (name === 'get_libsignal_device_number') return { data: 1, error: null };
        if (name === 'count_libsignal_prekey_bundles') return { data: 0, error: null };
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
});
