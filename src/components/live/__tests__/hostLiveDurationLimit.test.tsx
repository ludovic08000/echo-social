import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const endLiveMutateAsync = vi.fn().mockResolvedValue(undefined);
const toastSpy = vi.fn();

vi.mock('@/hooks/useLiveStreams', () => ({
  useLiveChat: () => ({ data: [] }),
  useSendLiveChatMessage: () => ({ mutate: vi.fn() }),
  useEndLive: () => ({ mutateAsync: endLiveMutateAsync }),
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: (...args: unknown[]) => toastSpy(...args),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'host-user' } }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      insert: () => Promise.resolve({ error: null }),
    }),
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('../LiveStreamPlayer', () => ({
  LiveStreamPlayer: () => null,
}));

vi.mock('../LiveEmojiPicker', () => ({
  LiveEmojiPicker: () => null,
}));

vi.mock('@/components/UserAvatar', () => ({
  UserAvatar: () => null,
}));

import { HostLiveView } from '../HostLiveView';

const baseLive = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: 'host-user',
  title: 'Test live',
  description: null,
  thumbnail_url: null,
  stream_key: 'key',
  is_active: true,
  viewer_count: 0,
  peak_viewer_count: 0,
  total_views: 0,
  category: null,
  hashtags: [],
  ended_at: null,
  recording_url: null,
} as any;

describe('HostLiveView — limite de durée 1 h', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    endLiveMutateAsync.mockClear();
    toastSpy.mockClear();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('termine automatiquement un live démarré il y a plus de 60 minutes', async () => {
    const live = { ...baseLive, started_at: new Date(Date.now() - 61 * 60 * 1000).toISOString() };
    render(<HostLiveView live={live} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(endLiveMutateAsync).toHaveBeenCalledWith(live.id);
  });

  it('ne termine pas un live récent et alerte à 55 minutes', async () => {
    const live = { ...baseLive, started_at: new Date(Date.now() - 54 * 60 * 1000).toISOString() };
    render(<HostLiveView live={live} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000); // passe le seuil des 55 min
    });
    expect(endLiveMutateAsync).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('5 minutes') }),
    );
  });
});
