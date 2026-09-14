import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const state = vi.hoisted(() => ({
  vault: new Map<string, unknown>(), encrypt: vi.fn(), rpc: vi.fn(),
  route: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/crypto/deviceVault', () => ({
  readDeviceVaultRecord: async (id: string) => state.vault.get(id) ?? null,
  writeDeviceVaultRecord: async (id: string, value: unknown) => { state.vault.set(id, value); },
}));
vi.mock('@/lib/messaging/currentDevice', () => ({ getCurrentDeviceId: () => 'sender-device', isDeviceIdTemporary: () => false }));
vi.mock('@/lib/crypto/deviceSessionQueue', () => ({ runDeviceSessionJob: async (_scope: string, _key: string, work: () => Promise<unknown>) => work() }));
vi.mock('@/lib/crypto/errorLogger', () => ({ logCryptoError: vi.fn(), logCryptoException: vi.fn() }));
vi.mock('@/lib/crypto/peerKeyCache', () => ({ getCachedAuthUserId: async () => 'sender' }));
vi.mock('@/lib/crypto/libsignalRuntime', () => ({
  encryptForLibsignalDevice: state.encrypt, decryptFromLibsignalDevice: vi.fn(), decodeLibsignalWire: vi.fn(),
}));
vi.mock('@/lib/messaging/fanoutRouteCache', () => ({ resolveFanoutRouteSnapshot: state.route, invalidateFanoutRoute: vi.fn() }));
vi.mock('@/lib/messaging/aegisTransport', () => ({ callAegisServer: state.rpc }));

import { buildFanoutCopies } from '../multiDeviceFanout';
import { sendMessageWithAegisRetry } from '../aegisSendRpc';
const messageId = '11111111-1111-4111-8111-111111111111';
const input = { messageId, conversationId: 'conversation', senderUserId: 'sender', plaintext: 'capsule' };
const device = (id: string) => ({ userId: 'recipient', deviceId: id, devicePublicKey: `key-${id}` });
beforeEach(() => {
  vi.clearAllMocks(); state.vault.clear(); localStorage.clear();
  let counter = 0;
  state.encrypt.mockImplementation(async () => `aegis.libsignal.3.${Buffer.from(`cipher-${++counter}`).toString('base64')}`);
});

it('reuses the successful target after partial fanout and later recovery', async () => {
  state.route.mockResolvedValue({ version: 'route', targets: [device('a'), device('b')] });
  const original = state.encrypt.getMockImplementation()!;
  state.encrypt.mockImplementation(async (args: { remoteDeviceId: string }) => {
    if (args.remoteDeviceId === 'b') throw new Error('bundle unavailable');
    return original();
  });
  await expect(buildFanoutCopies(input)).rejects.toThrow('E2EE_DEVICE_COPIES_UNAVAILABLE');
  expect(state.encrypt.mock.calls.filter(([args]) => args.remoteDeviceId === 'a')).toHaveLength(1);
  state.encrypt.mockImplementation(original);
  const recovered = await buildFanoutCopies(input);
  expect(recovered.rows).toHaveLength(2);
  expect(state.encrypt.mock.calls.filter(([args]) => args.remoteDeviceId === 'a')).toHaveLength(1);
});

it('rebuilds a stale route then confirms an ambiguous commit using identical copies', async () => {
  state.route.mockResolvedValueOnce({ version: 'old', targets: [device('a')] })
    .mockResolvedValue({ version: 'new', targets: [device('a'), device('b')] });
  const initial = await buildFanoutCopies(input);
  state.rpc.mockResolvedValueOnce({ data: null, error: { message: 'E2EE_DEVICE_LIST_STALE' } })
    .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
    .mockResolvedValueOnce({ data: { state: 'committed', message_id: messageId, request_digest: 'a'.repeat(64), existing: true }, error: null });
  const result = await sendMessageWithAegisRetry({
    ...input, body: 'encrypted-parent', imageUrl: null, extra: {}, senderDeviceId: 'sender-device',
    initialCopies: initial.rows, routeVersion: initial.routeVersion,
    rebuildCopies: async () => { const built = await buildFanoutCopies(input); return { copies: built.rows, routeVersion: built.routeVersion }; },
  });
  expect(result.error).toBeNull();
  expect(result.copies[0].encrypted_body).toBe(initial.rows[0].encrypted_body);
  expect(state.encrypt).toHaveBeenCalledTimes(2);
  expect(state.rpc.mock.calls[1][1]).toEqual(state.rpc.mock.calls[2][1]);
});

it('keeps the transport disconnected from session snapshot restoration', () => {
  for (const file of ['aegisSendRpc', 'aegisOutboundEngine', 'multiDeviceFanout']) {
    const source = readFileSync(`src/lib/messaging/${file}.ts`, 'utf8');
    expect(source).not.toMatch(/fanoutSessionTransaction|restoreLibsignalStore|rollbackFanoutSession/);
  }
});
