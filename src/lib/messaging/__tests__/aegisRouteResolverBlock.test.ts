import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  verify: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock('@/lib/crypto/deviceLinkTrust', () => ({
  verifyRouteDeviceIdentityOffline: mocks.verify,
}));

vi.mock('@/lib/messaging/e2eeTrace', () => ({
  traceE2EE: mocks.trace,
}));

import { resolveConversationRoute } from '@/lib/messaging/aegisRouteResolver';

describe('Aegis blocked conversation route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not verify or expose devices for a recipient who blocked the sender', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        route_version: 'route-version-blocked',
        self_user_id: 'sender-user',
        sender_device_id: 'sender-device-12345678',
        sender_device_routable: true,
        participants: [{
          user_id: 'recipient-user',
          is_self: false,
          routable_count: 0,
          total_count: 0,
          reason: 'BLOCKED_SENDER',
          devices: [],
        }],
      },
      error: null,
    });

    const route = await resolveConversationRoute(
      'conversation-one',
      'sender-user',
      'sender-device-12345678',
    );

    expect(route.targets).toEqual([]);
    expect(route.unroutableUserIds).toEqual([]);
    expect(route.blockedRecipients).toEqual([{
      userId: 'recipient-user',
      reason: 'recipient_block',
    }]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
