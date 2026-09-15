import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ capture: vi.fn(), upsert: vi.fn(), stored: null as unknown, mismatch: false }));
vi.mock('../aegisDeviceKeyVault', () => ({ captureEncryptedAegisDeviceVault: mocks.capture, restoreEncryptedAegisDeviceVault: vi.fn() }));
vi.mock('../deviceVault', () => ({ logDeviceVaultEvent: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const query = {
    upsert: mocks.upsert, select: () => query, eq: () => query,
    maybeSingle: async () => ({ data: { vault: mocks.mismatch ? null : mocks.stored }, error: null }),
  };
  return query;
} } }));
import { backupDeviceVaultToCloud } from '../deviceVaultSync';
const args = { userId: 'alice', deviceId: 'dev_0123456789abcdef0123456789abcdef' };
beforeEach(() => {
  vi.resetAllMocks(); mocks.stored = null; mocks.mismatch = false;
  mocks.capture.mockResolvedValue({ version: 2, iv: 'iv', ciphertext: 'sealed' });
  mocks.upsert.mockImplementation(async (row: { vault: unknown }) => { mocks.stored = row.vault; return { error: null }; });
});
describe('cloud backup ordering', () => {
  it('captures a second snapshot only after the first upload and readback', async () => {
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    mocks.capture.mockResolvedValueOnce({ version: 2, iv: 'old', ciphertext: 'old' })
      .mockResolvedValueOnce({ version: 2, iv: 'new', ciphertext: 'new' });
    mocks.upsert.mockImplementationOnce(async (row: { vault: unknown }) => {
      entered(); await gate; mocks.stored = row.vault; return { error: null };
    });
    const first = backupDeviceVaultToCloud(args); await ready;
    const second = backupDeviceVaultToCloud(args);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    release(); expect(await first).toBe(true); expect(await second).toBe(true);
    expect(mocks.stored).toEqual({ version: 2, iv: 'new', ciphertext: 'new' });
  });
  it('never confirms a mismatched readback', async () => {
    mocks.mismatch = true;
    expect(await backupDeviceVaultToCloud(args)).toBe(false);
  });
  it('releases the lock after an upload failure', async () => {
    mocks.upsert.mockRejectedValueOnce(new Error('offline'));
    expect(await backupDeviceVaultToCloud(args)).toBe(false);
    expect(await backupDeviceVaultToCloud(args)).toBe(true);
  });
});
