import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
const publishOwnSignedDeviceListMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: vi.fn(),
  },
}));

vi.mock('../signedDeviceList', () => ({
  publishOwnSignedDeviceList: (...args: unknown[]) => publishOwnSignedDeviceListMock(...args),
}));

import { ensureCurrentDevicePrimary } from '../devicePrimaryRepair';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureCurrentDevicePrimary', () => {
  it('republishes the signed device list when the current device is promoted', async () => {
    const invalidated = vi.fn();
    window.addEventListener('forsure:e2ee-device-list-invalidated', invalidated);
    rpcMock.mockResolvedValue({ data: { ok: true, code: 'PRIMARY_PROMOTED' }, error: null });
    publishOwnSignedDeviceListMock.mockResolvedValue(undefined);

    const result = await ensureCurrentDevicePrimary('user-1', 'device-current');

    expect(result).toEqual({ ok: true, changed: true, code: 'PRIMARY_PROMOTED' });
    expect(rpcMock).toHaveBeenCalledWith('ensure_current_device_primary', {
      p_device_id: 'device-current',
    });
    expect(publishOwnSignedDeviceListMock).toHaveBeenCalledWith({
      signerDeviceId: 'device-current',
    });
    expect(invalidated).toHaveBeenCalledTimes(1);
    window.removeEventListener('forsure:e2ee-device-list-invalidated', invalidated);
  });

  it('does not republish when another active primary already exists', async () => {
    rpcMock.mockResolvedValue({ data: { ok: true, code: 'PRIMARY_ALREADY_EXISTS' }, error: null });

    const result = await ensureCurrentDevicePrimary('user-1', 'device-current');

    expect(result).toEqual({ ok: true, changed: false, code: 'PRIMARY_ALREADY_EXISTS' });
    expect(publishOwnSignedDeviceListMock).not.toHaveBeenCalled();
  });
});
