import { beforeEach, describe, expect, it, vi } from 'vitest';

const { channel } = vi.hoisted(() => {
  const mockedChannel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  mockedChannel.on.mockReturnValue(mockedChannel);
  mockedChannel.subscribe.mockReturnValue(mockedChannel);
  return { channel: mockedChannel };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  },
}));

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  invalidateDeviceSession: vi.fn(),
}));

vi.mock('../fanoutRouteCache', () => ({
  invalidateAllFanoutRoutes: vi.fn(),
}));

vi.mock('../currentDevice', () => ({
  getCurrentDeviceId: vi.fn(() => 'device-local'),
}));

import { startRealtimeKeySync, stopRealtimeKeySync } from '../realtimeKeySync';

describe('realtimeKeySync module', () => {
  beforeEach(() => {
    stopRealtimeKeySync();
    vi.clearAllMocks();
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockReturnValue(channel);
  });

  it('loads and subscribes without referencing removed archive handlers', () => {
    const stop = startRealtimeKeySync({ userId: 'user-local' });

    expect(stop).toBeTypeOf('function');
    expect(channel.on).toHaveBeenCalledTimes(6);
    expect(channel.on.mock.calls.map((call) => call[1]?.table)).not.toContain(
      'device_one_time_prekeys',
    );
    expect(channel.subscribe).toHaveBeenCalledTimes(1);

    stop();
  });
});
