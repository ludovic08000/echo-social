import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), identity: vi.fn(), kx: vi.fn(), authorization: vi.fn(), rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const query = { select: () => query, eq: () => query, maybeSingle: mocks.lookup }; return query;
} } }));
vi.mock('@/lib/crypto/deviceIdentity', () => ({ loadDeviceIdentity: mocks.identity, prepareDeviceAuthorization: mocks.authorization }));
vi.mock('@/lib/crypto/deviceKx', () => ({ loadDeviceKxKey: mocks.kx }));
vi.mock('@/lib/api/deviceRpcTimeout', () => ({
  runDeviceRpcWithTimeout: (code: string) => (
    code === 'DEVICE_BINDING_LOOKUP_FAILED' ? mocks.lookup() : mocks.rpc()
  ),
}));
import { bindApprovedDeviceToAccount } from '../deviceAccountBinding';
import { clearDeviceFinalizationTrace, getDeviceFinalizationTrace } from '@/lib/device-manager/deviceFinalizationTrace';

beforeEach(() => {
  vi.resetAllMocks(); clearDeviceFinalizationTrace();
  mocks.lookup.mockResolvedValue({ data: { device_id: 'DEVICE_SENTINEL', device_signing_key: 'SIGNING_SENTINEL',
    device_public_key: 'EXCHANGE_SENTINEL', approval_status: 'approved', is_active: true, revoked_at: null, binding_status: 'pending' }, error: null });
  mocks.identity.mockResolvedValue({ publicB64: 'SIGNING_SENTINEL', privateKey: 'PRIVATE_SENTINEL' });
  mocks.kx.mockResolvedValue({ publicB64: 'EXCHANGE_SENTINEL', privateKey: 'PRIVATE_SENTINEL' });
  mocks.authorization.mockResolvedValue({ deviceSigning: { publicB64: 'SIGNING_SENTINEL' }, deviceKx: { publicB64: 'EXCHANGE_SENTINEL' }, authorizationSignature: 'SIGNATURE_SENTINEL' });
});

it.each(['signing', 'exchange'])('identifies a wrong %s key before signing or calling the binding RPC', async kind => {
  (kind === 'signing' ? mocks.identity : mocks.kx).mockResolvedValue({ publicB64: 'WRONG_SENTINEL' });
  await expect(bindApprovedDeviceToAccount('USER_SENTINEL', 'DEVICE_SENTINEL')).rejects.toThrow('DEVICE_LOCAL_KEY_MISMATCH');
  expect(getDeviceFinalizationTrace().find(e => e.step === `device_keys.${kind}Matches`)?.outcome).toBe('failure');
  expect(mocks.authorization).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  expect(JSON.stringify(getDeviceFinalizationTrace())).not.toContain('SENTINEL');
});

it('distinguishes a server signature rejection from a local key mismatch', async () => {
  mocks.rpc.mockResolvedValue({ data: { ok: false, code: 'ACCOUNT_BINDING_SIGNATURE_INVALID' }, error: null });
  await expect(bindApprovedDeviceToAccount('USER_SENTINEL', 'DEVICE_SENTINEL')).rejects.toThrow('ACCOUNT_BINDING_SIGNATURE_INVALID');
  expect(getDeviceFinalizationTrace().at(-1)).toMatchObject({ step: 'device_binding.server_result', outcome: 'failure', errorCode: 'ACCOUNT_BINDING_SIGNATURE_INVALID' });
  expect(JSON.stringify(getDeviceFinalizationTrace())).not.toContain('SENTINEL');
});

it('never labels a successful RPC for a different DeviceID as a valid binding', async () => {
  mocks.rpc.mockResolvedValue({ data: { ok: true, code: 'DEVICE_ACCOUNT_BOUND', device_id: 'OTHER_SENTINEL' }, error: null });
  await expect(bindApprovedDeviceToAccount('USER_SENTINEL', 'DEVICE_SENTINEL')).rejects.toThrow();
  expect(getDeviceFinalizationTrace().at(-1)).toMatchObject({ outcome: 'failure', errorCode: 'DEVICE_BINDING_DEVICE_MISMATCH' });
  expect(JSON.stringify(getDeviceFinalizationTrace())).not.toContain('SENTINEL');
});
