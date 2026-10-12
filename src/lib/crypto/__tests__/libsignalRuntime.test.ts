import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), encrypt: vi.fn(), establish: vi.fn(), renew: false, applied: vi.fn(), verify: vi.fn(), trust: vi.fn(), device: vi.fn(), readProof: vi.fn(), commitProof: vi.fn() }));
vi.mock('../libsignalBundleBinding', () => ({ verifyLibsignalBundleBinding: (...args: unknown[]) => mocks.verify(...args), libsignalIdentityFromVerifiedBundle: () => Uint8Array.of(5, 8, 9) }));
vi.mock('../libsignalSessionBinding', () => ({ readLibsignalSessionBinding: mocks.readProof, commitLibsignalSessionBinding: mocks.commitProof }));
vi.mock('../deviceLinkTrust', () => ({ getApprovedDeviceIdentity: (...args: unknown[]) => mocks.device(...args) }));
vi.mock('../fingerprintTracker', () => ({ assertExactPeerFingerprintTrusted: (...args: unknown[]) => mocks.trust(...args) }));
vi.mock('../libsignalSessionFreshness', () => ({
  withLibsignalSessionFreshness: (_args: unknown, work: (renew: boolean, applied: () => Promise<void>) => unknown) => work(mocks.renew, mocks.applied),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...args: unknown[]) => mocks.rpc(...args) } }));
vi.mock('@/lib/crypto/libsignalPlatformBridge', () => ({
  encryptLibsignalMessage: (...args: unknown[]) => mocks.encrypt(...args),
  establishLibsignalSession: (...args: unknown[]) => mocks.establish(...args),
  decryptLibsignalMessage: vi.fn(),
}));
import { encryptForLibsignalDevice } from '../libsignalRuntime';
import { __libsignalDeviceNumberTest } from '../libsignalDeviceNumber';
const args = { conversationId: 'conversation', ownerUserId: 'alice', ownerDeviceId: 'a', remoteUserId: 'bob', remoteDeviceId: 'b', plaintext: 'Bonjour 👋' };
beforeEach(() => {
  vi.resetAllMocks();
  __libsignalDeviceNumberTest.reset();
  mocks.renew = false;
  mocks.rpc.mockImplementation((name: string) => name === 'get_libsignal_device_number'
    ? { abortSignal: async () => ({ data: 1, error: null }) }
    : Promise.resolve({ data: [{ public_bundle: 'AQID',bundle_signature:'proof',device_number:1,registration_id:42 }], error: null }));
  mocks.establish.mockResolvedValue(undefined);
  mocks.device.mockResolvedValue({ deviceSigningKey:'approved-key',accountFingerprint:'pinned-account' });
  mocks.verify.mockResolvedValue(Uint8Array.of(1,2,3));
  mocks.trust.mockResolvedValue(undefined);
  mocks.readProof.mockResolvedValue(null);
  mocks.commitProof.mockResolvedValue(undefined);
});
describe('Libsignal first-message session bootstrap', () => {
  it('renews an invalidated session before any encryption', async () => {
    mocks.renew = true;
    mocks.encrypt.mockResolvedValue({ messageType: 3, ciphertext: Uint8Array.of(1, 2, 3) });
    await expect(encryptForLibsignalDevice(args)).resolves.toBe('aegis.libsignal.3.AQID');
    expect(mocks.encrypt).toHaveBeenCalledOnce();
    expect(mocks.establish.mock.invocationCallOrder[0]).toBeLessThan(mocks.encrypt.mock.invocationCallOrder[0]);
    expect(mocks.applied).toHaveBeenCalledOnce();
  });
  it('does not encrypt or acknowledge a renewal rejected by the trust check', async () => {
    mocks.renew = true;
    mocks.establish.mockRejectedValueOnce(new Error('UntrustedIdentity'));
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('UntrustedIdentity');
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.applied).not.toHaveBeenCalled();
  });
  it('does not release ciphertext when the renewal acknowledgement cannot be sealed', async () => {
    mocks.renew = true;
    mocks.applied.mockRejectedValueOnce(new Error('vault write failed'));
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('vault write failed');
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });
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
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(mocks.commitProof).not.toHaveBeenCalled();
  });
  it.each(['device','trust','verify'] as const)('rejects a failed %s before mutating the session', async (step) => {
    mocks.renew=true;
    mocks[step].mockRejectedValueOnce(new Error('IDENTITY_REJECTED'));
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('IDENTITY_REJECTED');
    expect(mocks.establish).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.applied).not.toHaveBeenCalled();
  });
  it('uses the exact approving account fingerprint and verifies before session establishment', async () => {
    mocks.renew=true;
    mocks.encrypt.mockResolvedValue({messageType:3,ciphertext:Uint8Array.of(1,2,3)});
    await encryptForLibsignalDevice(args);
    expect(mocks.trust).toHaveBeenCalledWith('alice','bob','pinned-account');
    expect(mocks.verify).toHaveBeenCalledWith({userId:'bob',deviceId:'b',deviceNumber:1,registrationId:42,publicBundle:'AQID'},'proof','approved-key');
    expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(mocks.establish.mock.invocationCallOrder[0]);
  });
  const proof = { deviceNumber: 1, registrationId: 42, publicBundle: 'AQID', signature: 'proof' };
  it('authenticates a warm session using its durable proof without consuming another prekey', async () => {
    mocks.readProof.mockResolvedValue(proof);
    mocks.encrypt.mockResolvedValue({ messageType: 2, ciphertext: Uint8Array.of(1) });
    await expect(encryptForLibsignalDevice(args)).resolves.toBe('aegis.libsignal.2.AQ==');
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.encrypt).toHaveBeenCalledWith(expect.objectContaining({ verifiedRemoteIdentity: Uint8Array.of(5,8,9) }));
    expect(mocks.device).toHaveBeenCalledWith('bob','b');
    expect(mocks.trust).toHaveBeenCalledWith('alice','bob','pinned-account');
    expect(mocks.rpc.mock.calls.every(([name]) => name === 'get_libsignal_device_number')).toBe(true);
    expect(mocks.establish).not.toHaveBeenCalled();
    expect(mocks.commitProof).not.toHaveBeenCalled();
  });
  it('upgrades an existing matching session without a new handshake', async () => {
    mocks.encrypt.mockResolvedValue({ messageType: 2, ciphertext: Uint8Array.of(1) });
    await encryptForLibsignalDevice(args);
    expect(mocks.establish).not.toHaveBeenCalled();
    expect(mocks.commitProof).toHaveBeenCalledWith(args, proof);
    expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(mocks.encrypt.mock.invocationCallOrder[0]);
  });
  it.each(['device','trust','verify'] as const)('refuses a warm session after %s rejection without bootstrap', async (step) => {
    mocks.readProof.mockResolvedValue(proof);
    mocks[step].mockRejectedValue(new Error('TRUST_REJECTED'));
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('TRUST_REJECTED');
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.establish).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'claim_libsignal_prekey_bundle')).toBe(false);
  });
  it('fails closed if the engine refuses the expected session identity', async () => {
    mocks.readProof.mockResolvedValue(proof);
    mocks.encrypt.mockRejectedValue(new Error('UntrustedIdentity'));
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('UntrustedIdentity');
    expect(mocks.establish).not.toHaveBeenCalled();
    expect(mocks.commitProof).not.toHaveBeenCalled();
  });
  it('does not release ciphertext if the new public proof cannot be persisted', async () => {
    mocks.encrypt.mockResolvedValue({ messageType: 2, ciphertext: Uint8Array.of(1) });
    mocks.commitProof.mockRejectedValue(new Error('AEGIS_LIBSIGNAL_BINDING_COMMIT_FAILED'));
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('BINDING_COMMIT_FAILED');
    expect(mocks.establish).not.toHaveBeenCalled();
  });
  it('does not interpret a locked proof vault as a missing proof', async () => {
    mocks.readProof.mockRejectedValue(new Error('VAULT_LOCKED'));
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('VAULT_LOCKED');
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'claim_libsignal_prekey_bundle')).toBe(false);
  });
  it('rejects a cached proof for a different numeric device route', async () => {
    mocks.readProof.mockResolvedValue({ ...proof, deviceNumber: 2 });
    await expect(encryptForLibsignalDevice(args)).rejects.toThrow('BUNDLE_BINDING_INVALID');
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });
  it('obtains a fresh bundle only when a cached proof has no corresponding session', async () => {
    mocks.readProof.mockResolvedValue(proof);
    mocks.encrypt.mockRejectedValueOnce(new Error('SessionNotFound')).mockResolvedValueOnce({ messageType: 3, ciphertext: Uint8Array.of(1) });
    await encryptForLibsignalDevice(args);
    expect(mocks.establish).toHaveBeenCalledOnce();
    expect(mocks.commitProof).toHaveBeenCalledOnce();
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'claim_libsignal_prekey_bundle')).toHaveLength(1);
  });
});
