import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bufferToBase64 } from '@/lib/crypto/utils';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  ensureReady: vi.fn(),
  assertTrusted: vi.fn(),
  buildCopies: vi.fn(),
  decryptCopy: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/e2ee-session', () => ({
  safeUUID: vi.fn()
    .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
    .mockReturnValueOnce('22222222-2222-4222-8222-222222222222'),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));
vi.mock('@/lib/messaging/aegisDeviceRuntime', () => ({
  ensureAegisDeviceReady: mocks.ensureReady,
}));
vi.mock('@/lib/crypto/fingerprintTracker', () => ({
  assertConversationFingerprintsTrusted: mocks.assertTrusted,
}));
vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  buildFanoutCopies: mocks.buildCopies,
  tryDecryptDeviceTargetedBody: mocks.decryptCopy,
}));
vi.mock('@/lib/messaging/fanoutSessionTransaction', () => ({
  commitFanoutSessionTransaction: mocks.commit,
  rollbackFanoutSessionTransaction: mocks.rollback,
}));
vi.mock('@/lib/messaging/fanoutRouteCache', () => ({
  invalidateFanoutRoute: mocks.invalidate,
}));

import {
  createSecureCallKeyCapsule,
  parseSecureCallKeyCapsule,
  startSecureCall,
} from '@/lib/calls/secureCallKeys';

const CALLER = '33333333-3333-4333-8333-333333333333';
const INVITEE = '44444444-4444-4444-8444-444444444444';
const CONVERSATION = '55555555-5555-4555-8555-555555555555';
const KEY = bufferToBase64(new Uint8Array(32).fill(9).buffer as ArrayBuffer);
const COPY = {
  message_id: '11111111-1111-4111-8111-111111111111',
  recipient_user_id: INVITEE,
  recipient_device_id: 'recipient-device-v2',
  sender_user_id: CALLER,
  sender_device_id: 'sender-device-v2',
  encrypted_body: 'aegis1.ratchet.s7AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=.0.0.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureReady.mockResolvedValue({ deviceId: 'sender-device-v2', userId: CALLER });
  mocks.assertTrusted.mockResolvedValue(undefined);
  mocks.buildCopies.mockResolvedValue({ rows: [COPY], hasTargets: true, routeVersion: 'route-v2' });
  mocks.rpc.mockResolvedValue({
    data: {
      ok: true,
      id: '11111111-1111-4111-8111-111111111111',
      room_id: '22222222-2222-4222-8222-222222222222',
    },
    error: null,
  });
});

describe('secure per-device call-key distribution', () => {
  it('binds a 32-byte key to the call context', () => {
    const capsule = createSecureCallKeyCapsule({
      callId: '11111111-1111-4111-8111-111111111111',
      conversationId: CONVERSATION,
      callerUserId: CALLER,
      callKeyB64: KEY,
      createdAt: 1,
    });
    expect(parseSecureCallKeyCapsule(capsule)).toMatchObject({
      callId: '11111111-1111-4111-8111-111111111111',
      conversationId: CONVERSATION,
      callerUserId: CALLER,
      callKey: KEY,
    });
    expect(parseSecureCallKeyCapsule(capsule.replace(CONVERSATION, 'bad'))).toBeNull();
  });

  it('sends only encrypted device copies and never the raw call key to Supabase', async () => {
    const started = await startSecureCall({
      conversationId: CONVERSATION,
      callerUserId: CALLER,
      inviteeIds: [INVITEE],
      callType: 'audio',
      callKeyB64: KEY,
    });
    expect(started.callId).toBe('11111111-1111-4111-8111-111111111111');
    expect(mocks.buildCopies).toHaveBeenCalledWith(expect.objectContaining({
      recipientUserIds: [INVITEE],
    }));
    const rpcArgs = mocks.rpc.mock.calls[0][1];
    expect(JSON.stringify(rpcArgs)).not.toContain(KEY);
    expect(rpcArgs.p_key_copies).toEqual([expect.objectContaining({
      recipient_user_id: INVITEE,
      encrypted_body: COPY.encrypted_body,
    })]);
    expect(mocks.commit).toHaveBeenCalledWith(started.callId);
  });
});
