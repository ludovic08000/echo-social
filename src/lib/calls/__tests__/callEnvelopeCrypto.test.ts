import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), approved: vi.fn(), trust: vi.fn() }));
vi.mock('@/lib/crypto/deviceKx', () => ({ loadDeviceKxKey: mocks.load }));
vi.mock('@/lib/crypto/deviceLinkTrust', () => ({ getApprovedDeviceIdentity: mocks.approved }));
vi.mock('@/lib/crypto/fingerprintTracker', () => ({ assertExactPeerFingerprintTrusted: mocks.trust }));

import { bufferToBase64, encodeString } from '@/lib/crypto/utils';
import { generateCallE2EEKey } from '../callKey';
import { openCallKeyForCurrentDevice, sealCallKeyForDevice } from '../aegisCallProtocol';
import { callInvitationProofPayload } from '../callInvitationProof';

const context = {
  callId: '018f65a7-8c4a-4bda-9f4f-f449c40f4b40',
  conversationId: '123e4567-e89b-42d3-a456-426614174000',
  callerId: '22222222-2222-4222-8222-222222222222',
  callType: 'audio' as const, isGroup: false,
  recipientUserId: '11111111-1111-4111-8111-111111111111',
  recipientDeviceId: 'device-one',
};
let signing: CryptoKeyPair;
let recipientPublicKey: string;
let mediaKey: string;
beforeEach(async () => {
  vi.resetAllMocks();
  const pair = await crypto.subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
  signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  recipientPublicKey = bufferToBase64(await crypto.subtle.exportKey('raw', pair.publicKey));
  mocks.load.mockResolvedValue(pair);
  mocks.approved.mockResolvedValue({ deviceId: 'caller-device', accountFingerprint: 'pinned-account',
    deviceSigningKey: bufferToBase64(await crypto.subtle.exportKey('raw', signing.publicKey)) });
  mocks.trust.mockResolvedValue(undefined);
  mediaKey = generateCallE2EEKey();
});
const seal = (key = signing.privateKey) => sealCallKeyForDevice({ ...context, callKey: mediaKey,
  recipientDevicePublicKey: recipientPublicKey, callerDeviceId: 'caller-device', callerSigningPrivateKey: key });
const open = (envelope: string) => openCallKeyForCurrentDevice({ ...context, envelope });

describe('device-authenticated Aegis call invitations with real cryptography', () => {
  it('round-trips the same media key using Ed25519 + X25519/HKDF/AES-GCM', async () => {
    const envelope = await seal();
    expect(envelope.split('.')).toHaveLength(6);
    expect(envelope).not.toContain(mediaKey);
    await expect(open(envelope)).resolves.toBe(mediaKey);
    expect(mocks.approved).toHaveBeenCalledWith(context.callerId, 'caller-device');
    expect(mocks.trust).toHaveBeenCalledWith(context.recipientUserId, context.callerId, 'pinned-account');
    expect(mocks.trust.mock.invocationCallOrder[0]).toBeLessThan(mocks.load.mock.invocationCallOrder[0]);
  });
  it.each([
    ['callId', '318f65a7-8c4a-4bda-9f4f-f449c40f4b40'],
    ['conversationId', '323e4567-e89b-42d3-a456-426614174000'],
    ['callerId', '33333333-3333-4333-8333-333333333333'],
    ['recipientUserId', '33333333-3333-4333-8333-333333333333'],
    ['recipientDeviceId', 'other-device'], ['callType', 'video'], ['isGroup', true],
  ])('rejects a substituted %s before reading local private keys', async (field, value) => {
    await expect(openCallKeyForCurrentDevice({ ...context, [field]: value, envelope: await seal() }))
      .rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3, 5])('rejects a tampered envelope component %i', async (index) => {
    const parts = (await seal()).split('.');
    parts[index] = (parts[index][0] === 'A' ? 'B' : 'A') + parts[index].slice(1);
    await expect(open(parts.join('.'))).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('rejects another device identifier even if the registry returns the same public key', async () => {
    const parts = (await seal()).split('.');
    parts[4] = bufferToBase64(encodeString('other-device'));
    await expect(open(parts.join('.'))).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('rejects a correctly encrypted envelope signed by an unapproved key', async () => {
    const attacker = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    await expect(open(await seal(attacker.privateKey))).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each(['DEVICE_ROUTE_NOT_AUTHORIZED', 'DEVICE_AUTHORIZATION_INVALID'])('refuses an unavailable/revoked sender: %s', async (code) => {
    mocks.approved.mockRejectedValue(new Error(code));
    await expect(open(await seal())).rejects.toThrow(code);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('refuses a changed account fingerprint before opening the envelope', async () => {
    mocks.trust.mockRejectedValue(new Error('FINGERPRINT_CHANGED'));
    await expect(open(await seal())).rejects.toThrow('FINGERPRINT_CHANGED');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('never regenerates a missing recipient key', async () => {
    mocks.load.mockResolvedValue(null);
    await expect(open(await seal())).rejects.toThrow('CALL_CURRENT_DEVICE_NOT_READY');
  });
  it('requires an update for an unsigned historical invitation, never an unsigned fallback', async () => {
    await expect(open((await seal()).split('.').slice(0, 4).join('.'))).rejects.toThrow('CALL_CLIENT_UPDATE_REQUIRED');
    expect(mocks.approved).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('rejects a non-canonical key encoding even when it decodes to the same bytes', async () => {
    const parts = (await seal()).split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const index = parts[1].length - 2;
    parts[1] = parts[1].slice(0, index) + alphabet[alphabet.indexOf(parts[1][index]) + 1] + '=';
    await expect(open(parts.join('.'))).rejects.toThrow('CALL_INVITATION_INVALID');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each(['aegis-call-v1.invalid', 'aegis-call-v1.' + 'a'.repeat(8192)])('rejects malformed input without a registry lookup', async (envelope) => {
    await expect(open(envelope)).rejects.toThrow('CALL_INVITATION_INVALID');
    expect(mocks.approved).not.toHaveBeenCalled();
  });
  it('retains the AES-GCM conversation binding independently of the signature', async () => {
    const parts = (await seal()).split('.');
    const changed = { ...context, conversationId: '323e4567-e89b-42d3-a456-426614174000' };
    parts[5] = bufferToBase64(await crypto.subtle.sign('Ed25519', signing.privateKey,
      encodeString(callInvitationProofPayload(changed, 'caller-device', parts.slice(0, 5).join('.')))));
    await expect(openCallKeyForCurrentDevice({ ...changed, envelope: parts.join('.') })).rejects.toThrow('CALL_INVITATION_INVALID');
    expect(mocks.load).toHaveBeenCalledOnce();
  });
});
