import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), records: new Map<string, unknown>() }));
vi.mock('../deviceVault', () => ({ readDeviceVaultRecord: mocks.read, writeDeviceVaultRecord: mocks.write }));
import { commitLibsignalSessionBinding, readLibsignalSessionBinding } from '../libsignalSessionBinding';
const owner = { ownerUserId:'alice', ownerDeviceId:'phone', remoteUserId:'bob', remoteDeviceId:'pc' };
const proof = { deviceNumber: 1, registrationId: 42, publicBundle:'public-only', signature:'A'.repeat(88) };
beforeEach(() => {
  vi.clearAllMocks(); mocks.records.clear();
  mocks.read.mockImplementation(async (id: string, valid: (value: unknown) => boolean) => {
    const value = mocks.records.get(id); return valid(value) ? value : null;
  });
  mocks.write.mockImplementation(async (id: string, value: unknown) => { mocks.records.set(id,value); });
});
describe('durable public session binding, never private ratchet state', () => {
  it('commits with readback and preserves the complete signed proof', async () => {
    await commitLibsignalSessionBinding(owner,proof);
    await expect(readLibsignalSessionBinding(owner)).resolves.toEqual(proof);
    expect(mocks.write).toHaveBeenCalledOnce();
  });
  it.each(['ownerUserId','ownerDeviceId','remoteUserId','remoteDeviceId'] as const)('isolates %s', async field => {
    await commitLibsignalSessionBinding(owner,proof);
    await expect(readLibsignalSessionBinding({...owner,[field]:'other'})).resolves.toBeNull();
  });
  it.each([{deviceNumber:128},{registrationId:0},{signature:''},{publicBundle:''}])('refuses malformed proof %o', async change => {
    await expect(commitLibsignalSessionBinding(owner,{...proof,...change})).rejects.toThrow('BUNDLE_BINDING_INVALID');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('propagates read failures instead of claiming a new identity', async () => {
    mocks.read.mockRejectedValue(new Error('vault locked'));
    await expect(readLibsignalSessionBinding(owner)).rejects.toThrow('vault locked');
  });
  it('refuses an absent or different readback', async () => {
    mocks.read.mockResolvedValue(null);
    await expect(commitLibsignalSessionBinding(owner,proof)).rejects.toThrow('BINDING_COMMIT_FAILED');
    mocks.read.mockResolvedValue({...proof,publicBundle:'changed'});
    await expect(commitLibsignalSessionBinding(owner,proof)).rejects.toThrow('BINDING_COMMIT_FAILED');
  });
});
