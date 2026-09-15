import { beforeEach, expect, it, vi } from 'vitest';
import { VALID_RATCHET_COPY } from '@/test/aegisWireFixtures';

const vault = vi.hoisted(() => ({ records: new Map<string, unknown>(), read: vi.fn(), write: vi.fn() }));
vi.mock('@/lib/crypto/deviceVault', () => ({
  readDeviceVaultRecord: (...args: unknown[]) => vault.read(...args),
  writeDeviceVaultRecord: (...args: unknown[]) => vault.write(...args),
}));
import { getOrCreateFanoutCopy } from '../fanoutCopyCache';

const args = {
  messageId: 'message', conversationId: 'conversation', senderUserId: 'alice',
  senderDeviceId: 'phone', recipientUserId: 'bob', recipientDeviceId: 'tablet',
  recipientDevicePublicKey: 'public', plaintext: 'secret capsule',
};
beforeEach(() => {
  vi.resetAllMocks();
  vault.records.clear();
  vault.read.mockImplementation(async (id: string) => vault.records.get(id) ?? null);
  vault.write.mockImplementation(async (id: string, value: unknown) => { vault.records.set(id, value); });
});

it('reuses sealed ciphertext after a route rejection and after module reload', async () => {
  const encrypt = vi.fn(async () => VALID_RATCHET_COPY);
  expect(await getOrCreateFanoutCopy(args, encrypt)).toBe(VALID_RATCHET_COPY);
  vi.resetModules();
  const reloaded = await import('../fanoutCopyCache');
  expect(await reloaded.getOrCreateFanoutCopy(args, encrypt)).toBe(VALID_RATCHET_COPY);
  expect(encrypt).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...vault.records.values()])).not.toContain(args.plaintext);
});

it('does not reuse ciphertext across changed device keys', async () => {
  const encrypt = vi.fn(async () => VALID_RATCHET_COPY);
  await getOrCreateFanoutCopy(args, encrypt);
  await getOrCreateFanoutCopy({ ...args, recipientDevicePublicKey: 'replacement' }, encrypt);
  expect(encrypt).toHaveBeenCalledTimes(2);
});

it.each([{ plaintext: 'changed' }, { conversationId: 'other' }])('rejects UUID reuse with different contents %j', async (change) => {
  const encrypt = vi.fn(async () => VALID_RATCHET_COPY);
  await getOrCreateFanoutCopy(args, encrypt);
  await expect(getOrCreateFanoutCopy({ ...args, ...change }, encrypt)).rejects.toThrow('MESSAGE_ID_CONFLICT');
  expect(encrypt).toHaveBeenCalledTimes(1);
});

it('never releases a ciphertext when its durable write fails', async () => {
  vault.write.mockRejectedValue(new Error('vault full'));
  await expect(getOrCreateFanoutCopy(args, async () => VALID_RATCHET_COPY)).rejects.toThrow('vault full');
});

it('does not turn a vault read failure into a new encryption', async () => {
  vault.read.mockRejectedValue(new Error('vault locked'));
  const encrypt = vi.fn(async () => VALID_RATCHET_COPY);
  await expect(getOrCreateFanoutCopy(args, encrypt)).rejects.toThrow('vault locked');
  expect(encrypt).not.toHaveBeenCalled();
});
