import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), ensureApprovedDeviceTrust: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'sender-device', isDeviceIdTemporary: () => false,
}));
vi.mock('@/lib/crypto/deviceLinkTrust', () => ({ ensureApprovedDeviceTrust: mocks.ensureApprovedDeviceTrust }));
vi.mock('@/lib/crypto/x3dh', () => ({ peekDeviceSignedPrekey: vi.fn(async () => ({ signedPrekeyId: 1 })) }));

import { invalidateVerifiedDeviceCache, listFanoutTargets } from '@/e2ee-session/deviceRegistry';

function route(userId: string, deviceId = `${userId}-device`) {
  return { device_id: deviceId, device_public_key: 'A'.repeat(44), platform: 'web', last_seen_at: null };
}

describe('device registry fail-closed fan-out gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateVerifiedDeviceCache();
    mocks.ensureApprovedDeviceTrust.mockResolvedValue(undefined);
    mocks.rpc.mockImplementation(async (_name: string, args: { p_user_id: string }) => ({
      data: [route(args.p_user_id)], error: null,
    }));
  });

  it('quarantines an invalid route while retaining a valid route', async () => {
    mocks.rpc.mockImplementation(async (_name: string, args: { p_user_id: string }) => ({
      data: args.p_user_id === 'peer'
        ? [route('peer', 'peer-valid'), route('peer', 'peer-invalid')]
        : [route(args.p_user_id)],
      error: null,
    }));
    mocks.ensureApprovedDeviceTrust.mockImplementation(async (_userId: string, deviceId: string) => {
      if (deviceId === 'peer-invalid') throw new Error('BAD_DEVICE_AUTHORIZATION');
    });
    const targets = await listFanoutTargets('sender', ['peer'], { verifyPrekeys: false });
    expect(targets.map((target) => target.deviceId).sort()).toEqual(['peer-valid', 'sender-device']);
  });

  it('fails closed when every route for a participant is invalid', async () => {
    mocks.ensureApprovedDeviceTrust.mockImplementation(async (userId: string) => {
      if (userId === 'peer') throw new Error('BAD_DEVICE_AUTHORIZATION');
    });
    await expect(listFanoutTargets('sender', ['peer'], { verifyPrekeys: false }))
      .rejects.toThrow('E2EE_DEVICE_REGISTRY_INVALID');
  });

  it('rejects the complete fanout when a participant has no ready route', async () => {
    mocks.rpc.mockImplementation(async (_name: string, args: { p_user_id: string }) => ({
      data: args.p_user_id === 'peer' ? [] : [route(args.p_user_id)], error: null,
    }));
    await expect(listFanoutTargets('sender', ['peer'], { verifyPrekeys: false }))
      .rejects.toThrow('E2EE_PARTICIPANT_ROUTE_UNAVAILABLE:peer');
  });

  it('does not downgrade an RPC failure into a partial fanout', async () => {
    mocks.rpc.mockImplementation(async (_name: string, args: { p_user_id: string }) => ({
      data: args.p_user_id === 'peer' ? null : [route(args.p_user_id)],
      error: args.p_user_id === 'peer' ? new Error('network') : null,
    }));
    await expect(listFanoutTargets('sender', ['peer'], { verifyPrekeys: false }))
      .rejects.toThrow('E2EE_DEVICE_REGISTRY_UNAVAILABLE');
  });

  it('returns all routes only after every participant verifies', async () => {
    const targets = await listFanoutTargets('sender', ['peer'], { verifyPrekeys: false });
    expect(targets.map((target) => target.userId).sort()).toEqual(['peer', 'sender']);
  });
});
