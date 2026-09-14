import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ records: new Map<string, unknown>(), read: vi.fn(), write: vi.fn() }));
vi.mock('../deviceVault', () => ({ readDeviceVaultRecord: mocks.read, writeDeviceVaultRecord: mocks.write }));
// Real cross-tab locking uses the test IndexedDB implementation.
const route = { ownerUserId: 'alice', ownerDeviceId: 'phone', remoteUserId: 'bob', remoteDeviceId: 'phone' };
let policy: typeof import('../libsignalSessionFreshness');
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.records.clear();
  mocks.read.mockImplementation(async (key: string) => mocks.records.get(key) ?? null);
  mocks.write.mockImplementation(async (key: string, record: unknown) => { mocks.records.set(key, record); });
  policy = await import('../libsignalSessionFreshness');
});
const needsRenewal = (args = route) => policy.withLibsignalSessionFreshness(args, async renew => renew);
describe('persisted Libsignal session freshness', () => {
  it('does not force renewal without a security event', async () => {
    expect(await needsRenewal()).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('invalidates only the selected peer and persists across a module reload', async () => {
    await policy.invalidateLibsignalDeviceSession('alice', 'phone', 'bob', 'phone');
    vi.resetModules(); policy = await import('../libsignalSessionFreshness');
    expect(await needsRenewal()).toBe(true);
    expect(await needsRenewal({ ...route, remoteDeviceId: 'tablet' })).toBe(false);
    expect(await needsRenewal({ ...route, ownerUserId: 'carol' })).toBe(false);
  });
  it('requires each peer to renew after an owner security event', async () => {
    await policy.invalidateLibsignalSessions('alice');
    await policy.withLibsignalSessionFreshness(route, async (renew, established) => {
      expect(renew).toBe(true); await established();
    });
    expect(await needsRenewal()).toBe(false);
    expect(await needsRenewal({ ...route, remoteUserId: 'carol' })).toBe(true);
    await policy.invalidateLibsignalSessions('alice');
    expect(await needsRenewal()).toBe(true);
  });
  it('keeps invalidation pending after handshake failure', async () => {
    await policy.invalidateLibsignalSessions('alice');
    await expect(policy.withLibsignalSessionFreshness(route, async () => { throw new Error('untrusted'); })).rejects.toThrow('untrusted');
    expect(await needsRenewal()).toBe(true);
  });
  it('blocks sending when invalidation cannot be persisted, then recovers', async () => {
    mocks.write.mockRejectedValue(new Error('locked'));
    await expect(policy.invalidateLibsignalSessions('alice')).rejects.toThrow('locked');
    const send = vi.fn();
    await expect(policy.withLibsignalSessionFreshness(route, send)).rejects.toThrow('locked');
    expect(send).not.toHaveBeenCalled();
    mocks.write.mockImplementation(async (key: string, record: unknown) => { mocks.records.set(key, record); });
    expect(await needsRenewal()).toBe(true);
  });
  it('blocks sending on read failure', async () => {
    mocks.read.mockRejectedValue(new Error('corrupt'));
    const send = vi.fn();
    await expect(policy.withLibsignalSessionFreshness(route, send)).rejects.toThrow('corrupt');
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects an invalidation whose readback was lost', async () => {
    mocks.write.mockResolvedValue(undefined);
    await expect(policy.invalidateLibsignalSessions('alice')).rejects.toThrow('INVALIDATION_COMMIT_FAILED');
  });
  it('serializes invalidation after an already running send', async () => {
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const sending = policy.withLibsignalSessionFreshness(route, async () => { entered(); await gate; });
    await ready;
    const invalidating = policy.invalidateLibsignalSessions('alice');
    expect(mocks.write).not.toHaveBeenCalled();
    release(); await sending; await invalidating;
    expect(await needsRenewal()).toBe(true);
  });
});
