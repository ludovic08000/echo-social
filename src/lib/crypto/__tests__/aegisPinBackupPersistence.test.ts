import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setupBackupPin: vi.fn(),
  exportArchiveMasterKeyForDeviceLink: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  setupBackupPin: mocks.setupBackupPin,
}));

vi.mock('@/lib/crypto/archiveMasterKey', () => ({
  exportArchiveMasterKeyForDeviceLink: mocks.exportArchiveMasterKeyForDeviceLink,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      refreshSession: mocks.refreshSession,
    },
    rpc: mocks.rpc,
    from: mocks.from,
  },
}));

import { setupPersistentBackupPin } from '@/lib/crypto/aegisPinBackup';

describe('Aegis PIN backup persistence proof', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
      error: null,
    });
    mocks.refreshSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
      error: null,
    });
    mocks.setupBackupPin.mockResolvedValue('error');
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.exportArchiveMasterKeyForDeviceLink.mockResolvedValue(null);
  });

  it('does not treat an existing older backup as proof that the requested PIN was saved', async () => {
    await expect(setupPersistentBackupPin('123456', 'user-1')).resolves.toBe('error');

    expect(mocks.setupBackupPin).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.exportArchiveMasterKeyForDeviceLink).not.toHaveBeenCalled();
  });
});
