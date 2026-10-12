import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ trust: vi.fn(), exactTrust: vi.fn(), approved: vi.fn(), signing: vi.fn(), loadKx: vi.fn(), devices: vi.fn(), rpc: vi.fn(), getUser: vi.fn() }));
vi.mock('@/lib/crypto/fingerprintTracker', () => ({ assertPeerFingerprintsTrusted: mocks.trust, assertExactPeerFingerprintTrusted: mocks.exactTrust }));
vi.mock('@/lib/crypto/deviceIdentity', () => ({ loadDeviceIdentity: mocks.signing }));
vi.mock('@/lib/crypto/deviceLinkTrust', () => ({ getApprovedDeviceIdentity: mocks.approved }));
vi.mock('@/lib/crypto/deviceKx', () => ({ loadDeviceKxKey: mocks.loadKx }));
vi.mock('@/lib/crypto/canonicalDeviceRegistry', () => ({ fetchVerifiedDeviceList: mocks.devices }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, auth: { getUser: mocks.getUser } } }));
vi.mock('@/lib/messaging/currentDevice', () => ({
  hydrateDeviceId: async () => 'test-device', getCurrentDeviceId: () => 'test-device', isDeviceIdTemporary: () => false,
}));
import { createAegisCall, latestAegisCallForCurrentDevice, loadCurrentDeviceCallInvitation, roomNameForCall, sealCallKeyForDevice } from '../aegisCallProtocol';
import { generateCallE2EEKey } from '../callKey';
import { callErrorUserMessage } from '../callDiagnostics';
import { bufferToBase64 } from '@/lib/crypto/utils';

const callerId = '11111111-1111-4111-8111-111111111111';
const peerId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const callId = '44444444-4444-4444-8444-444444444444';
let publicKey: string;
let signing: CryptoKeyPair;
beforeEach(async () => {
  vi.resetAllMocks();
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  publicKey = bufferToBase64(await crypto.subtle.exportKey('raw', pair.publicKey));
  signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  mocks.signing.mockResolvedValue(signing);
  mocks.approved.mockResolvedValue({ deviceId: 'test-device', accountFingerprint: 'pinned-caller',
    deviceSigningKey: bufferToBase64(await crypto.subtle.exportKey('raw', signing.publicKey)) });
  mocks.loadKx.mockResolvedValue({ ...pair, publicB64: publicKey });
  mocks.trust.mockResolvedValue(undefined);
  mocks.exactTrust.mockResolvedValue(undefined);
  mocks.devices.mockResolvedValue({ trusted: [{ deviceId: 'test-device', devicePublicKey: publicKey, isRoutable: true, accountFingerprint: 'pinned-peer' }] });
  mocks.getUser.mockResolvedValue({ data: { user: { id: peerId } }, error: null });
  mocks.rpc.mockImplementation(async (_name, args) => ({ data: { ok: true, call_id: args.p_call_id }, error: null }));
});
const outgoing = () => createAegisCall({ callerId, conversationId, inviteeIds: [peerId], callType: 'audio', callKey: generateCallE2EEKey() });
async function incoming() {
  const callKey = generateCallE2EEKey();
  const envelope = await sealCallKeyForDevice({ callKey, callId, conversationId,
    callerId, callerDeviceId: 'test-device', callerSigningPrivateKey: signing.privateKey, callType: 'audio', isGroup: false,
    recipientUserId: peerId, recipientDeviceId: 'test-device', recipientDevicePublicKey: publicKey });
  mocks.rpc.mockResolvedValue({ data: { ok: true, call_id: callId, conversation_id: conversationId, caller_id: callerId,
    call_type: 'audio', is_group: false, room_name: roomNameForCall(callId), encrypted_call_key: envelope }, error: null });
  return callKey;
}

describe('calls honor the same pinned identities as messages', () => {
  it('creates an encrypted call after trust succeeds', async () => {
    expect((await outgoing()).roomName).toMatch(/^call-/);
    expect(mocks.trust).toHaveBeenCalledWith(callerId, [peerId]);
    expect(mocks.exactTrust).toHaveBeenCalledWith(callerId, peerId, 'pinned-peer');
    expect(mocks.rpc).toHaveBeenCalledWith('aegis_call_create', expect.objectContaining({ p_caller_device_id: 'test-device' }));
  });
  it('blocks outgoing invitations on identity replacement before sending anything', async () => {
    mocks.trust.mockRejectedValue(new Error('FINGERPRINT_CHANGED'));
    await expect(outgoing()).rejects.toThrow('CALL_IDENTITY_CHANGED');
    expect(mocks.devices).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(callErrorUserMessage(new Error('FINGERPRINT_CHANGED'))).toContain('Vérifie son empreinte');
  });
  it('does not regenerate an identity when the local device key is missing', async () => {
    mocks.loadKx.mockResolvedValue(null);
    await expect(outgoing()).rejects.toThrow('CALL_CURRENT_DEVICE_NOT_READY');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('opens the signed incoming invitation with the original media key', async () => {
    const expected = await incoming();
    expect((await loadCurrentDeviceCallInvitation(callId)).callKey).toBe(expected);
    expect(mocks.exactTrust).toHaveBeenCalledWith(peerId, callerId, 'pinned-caller');
  });
  it.each(['FINGERPRINT_CHANGED', 'PEER_IDENTITY_BINDING_UNAVAILABLE'])('refuses an incoming %s before opening its key', async (error) => {
    await incoming();
    mocks.exactTrust.mockRejectedValue(new Error(error));
    await expect(loadCurrentDeviceCallInvitation(callId)).rejects.toThrow(error === 'FINGERPRINT_CHANGED' ? 'CALL_IDENTITY_CHANGED' : 'CALL_IDENTITY_UNAVAILABLE');
    expect(mocks.loadKx).not.toHaveBeenCalled();
  });
  it('does not generate a missing signing identity', async () => {
    mocks.signing.mockResolvedValue(null);
    await expect(outgoing()).rejects.toThrow('CALL_CURRENT_DEVICE_NOT_READY');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('catches a registry identity replacement after the preliminary trust check', async () => {
    mocks.exactTrust.mockRejectedValue(new Error('FINGERPRINT_CHANGED'));
    await expect(outgoing()).rejects.toThrow('CALL_IDENTITY_CHANGED');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(['CALL_INVITATION_SIGNATURE_INVALID', 'AEGIS_CLIENT_UPDATE_REQUIRED'])('preserves explicit SQL security errors: %s', async (message) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message } });
    await expect(outgoing()).rejects.toThrow(message === 'AEGIS_CLIENT_UPDATE_REQUIRED' ? 'CALL_CLIENT_UPDATE_REQUIRED' : message);
  });
  it.each([{ call_id: conversationId }, { is_group: 'false' }, { room_name: 'call-' + conversationId }])(
    'rejects inconsistent RPC metadata before local key access', async (mutation) => {
      await incoming();
      const response = await mocks.rpc();
      mocks.rpc.mockResolvedValue({ ...response, data: { ...response.data, ...mutation } });
      await expect(loadCurrentDeviceCallInvitation(callId)).rejects.toThrow('CALL_INVITATION_INVALID');
      expect(mocks.loadKx).not.toHaveBeenCalled();
    });
  it('authenticates the caller before presenting an incoming call, without opening local private keys', async () => {
    await incoming();
    const response = await mocks.rpc();
    mocks.rpc.mockImplementation(async (name) => name === 'aegis_call_latest_for_device'
      ? { data: { ok: true, call: { id: callId, caller_id: peerId, call_type: 'video' } }, error: null }
      : response);
    expect(await latestAegisCallForCurrentDevice()).toMatchObject({ id: callId, caller_id: callerId,
      conversation_id: conversationId, call_type: 'audio', is_group: false });
    expect(mocks.exactTrust).toHaveBeenCalledWith(peerId, callerId, 'pinned-caller');
    expect(mocks.loadKx).not.toHaveBeenCalled();
  });
  it('never presents a forged invitation as a ringing call', async () => {
    await incoming();
    const response = await mocks.rpc();
    const parts = response.data.encrypted_call_key.split('.');
    parts[5] = (parts[5][0] === 'A' ? 'B' : 'A') + parts[5].slice(1);
    response.data.encrypted_call_key = parts.join('.');
    mocks.rpc.mockImplementation(async (name) => name === 'aegis_call_latest_for_device'
      ? { data: { ok: true, call: { id: callId } }, error: null } : response);
    await expect(latestAegisCallForCurrentDevice()).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(mocks.loadKx).not.toHaveBeenCalled();
  });
  it('does not perform identity lookups when no call is ringing', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, call: null }, error: null });
    expect(await latestAegisCallForCurrentDevice()).toBeNull();
    expect(mocks.approved).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});
