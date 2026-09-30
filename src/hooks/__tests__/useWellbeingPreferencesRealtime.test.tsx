import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ChangeHandler = (payload: { new: Record<string, unknown> }) => void;

const realtime = vi.hoisted(() => {
  const channels = new Map<string, {
    name: string;
    subscribed: boolean;
    handler?: ChangeHandler;
  }>();

  const channel = vi.fn((name: string) => {
    const existing = channels.get(name);
    if (existing) return makeChannel(existing);

    const state = { name, subscribed: false };
    channels.set(name, state);
    return makeChannel(state);
  });

  function makeChannel(state: {
    name: string;
    subscribed: boolean;
    handler?: ChangeHandler;
  }) {
    const api = {
      on: vi.fn((_type: string, _filter: unknown, handler: ChangeHandler) => {
        if (state.subscribed) {
          throw new Error(`cannot add callbacks for realtime:${state.name} after subscribe()`);
        }
        state.handler = handler;
        return api;
      }),
      subscribe: vi.fn(() => {
        state.subscribed = true;
        return api;
      }),
    };
    return api;
  }

  const removeChannel = vi.fn(async (channelApi: unknown) => {
    const found = [...channels.entries()].find(([, state]) => state.handler && channelApi);
    if (found) channels.delete(found[0]);
    return 'ok';
  });

  return { channel, channels, removeChannel };
});

const database = vi.hoisted(() => ({
  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  upsert: vi.fn(async () => ({ error: null })),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: realtime.channel,
    removeChannel: realtime.removeChannel,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: database.maybeSingle })),
      })),
      upsert: database.upsert,
    })),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

import { useWellbeingPreferences } from '../useWellbeingPreferences';

function Consumer() {
  useWellbeingPreferences();
  return null;
}

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  realtime.channels.clear();
});

describe('useWellbeingPreferences Realtime lifecycle', () => {
  it('shares one subscribed channel across concurrent hook consumers', async () => {
    const view = render(
      <>
        <Consumer />
        <Consumer />
        <Consumer />
      </>,
    );

    await waitFor(() => expect(realtime.channel).toHaveBeenCalledTimes(1));
    expect(realtime.channel.mock.calls[0][0]).toMatch(/^wellbeing_prefs:user-1:/);
    expect(realtime.channels.size).toBe(1);

    view.unmount();
    await waitFor(() => expect(realtime.removeChannel).toHaveBeenCalledTimes(1));
  });

  it('uses a fresh topic when a consumer remounts during asynchronous cleanup', async () => {
    const first = render(<Consumer />);
    await waitFor(() => expect(realtime.channel).toHaveBeenCalledTimes(1));
    const firstTopic = realtime.channel.mock.calls[0][0];
    first.unmount();

    const second = render(<Consumer />);
    await waitFor(() => expect(realtime.channel).toHaveBeenCalledTimes(2));
    const secondTopic = realtime.channel.mock.calls[1][0];

    expect(secondTopic).toMatch(/^wellbeing_prefs:user-1:/);
    expect(secondTopic).not.toBe(firstTopic);
    second.unmount();
  });
});
