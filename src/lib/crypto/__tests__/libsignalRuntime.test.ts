import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), encrypt: vi.fn(), establish: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...args: unknown[]) => mocks.rpc(...args) } }));
vi.mock('@/lib/crypto/libsignalPlatformBridge', () => ({
  encryptLibsignalMessage: (...args: unknown[]) => mocks.encrypt(...args),
  establishLibsignalSession: (...args: unknown[]) => mocks.establish(...args),
  decryptLibsignalMessage: vi.fn(),
}));
import { encryptForLibsignalDevice } from '../libsignalRuntime';
const args = { conversationId: 'conversation', ownerUserId: 'alice', ownerDeviceId: 'a', remoteUserId: 'bob', remoteDeviceId: 'b', plaintext: 'Bonjour 👋' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'get_libsignal_device_number' ? 1 : [{ public_bundle: 'AQID' }], error: null }));
  mocks.establish.mockResolvedValue(undefined);
});
describe('Libsignal first-message session bootstrap', () => {
  it.each(['AEGIS_LIBSIGNAL:session with bob.1 not found: message_encrypt', 'SessionNotFound', 'session not found'])('claims and establishes a session for %s', async (message) => {
    mocks.encrypt.mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce({ messageType: 3, ciphertext: Uint8Array.of(1, 2, 3) });
    await expect(encryptForLibsignalDevice(args)).resolves.toBe('aegis.libsignal.3.AQID');
    expect(mocks.establish).toHaveBeenCalledOnce();
    expect(mocks.encrypt).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith('claim_libsignal_prekey_bundle', expect.objectContaining({ p_sender_device_id: 'a', p_device_id: 'b' }));
  });
  it('does not replace a session on storage or identity failure', async () => {
    mocks.encrypt.mockRejectedValueOnce(new Error('AEGIS_LIBSIGNAL_STORE_COMMIT_FAILED'));
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('STORE_COMMIT_FAILED');
    expect(mocks.establish).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});
