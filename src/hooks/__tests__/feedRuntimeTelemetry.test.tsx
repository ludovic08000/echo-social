import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(), enabled: true, user: { id: 'viewer' }, hidden: false,
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/lib/privacyPreferences', () => ({ isAnalyticsEnabled: () => mocks.enabled }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: () => ({ upsert: mocks.upsert }),
  auth: { getSession: async () => ({ data: { session: { user: mocks.user } }, error: null }) },
} }));
import { useQualityTracker } from '../useQualityTracker';
import { emitFeedPerformanceMetric, useFeedPerformance } from '../useFeedPerformance';

beforeEach(() => {
  vi.useFakeTimers();
  mocks.enabled = true;
  mocks.hidden = false;
  mocks.upsert.mockReset().mockResolvedValue({ error: null });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => mocks.hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => mocks.hidden ? 'hidden' : 'visible' });
});
afterEach(async () => {
  cleanup();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  vi.useRealTimers();
});
const rows = () => mocks.upsert.mock.calls.flatMap(call => call[0]);

describe('foreground and operational feed measurements', () => {
  it('does not equate hidden time with video completion or iOS performance', async () => {
    const hook = renderHook(() => useQualityTracker({ surface: 'post', contentId: 'post', durationMs: 1000 }));
    act(() => hook.result.current.onEnter());
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(rows().filter(row => row.event_type === 'view')).toHaveLength(0); // still batched
    act(() => {
      mocks.hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(rows().filter(row => row.event_type === 'view')).toHaveLength(1);
    expect(rows().some(row => ['completion', 'ios_perf', 'rewatch'].includes(row.event_type))).toBe(false);
    expect(rows().every(row => row.value < 2000)).toBe(true);
  });

  it('retries an API error with stable metric IDs instead of losing the batch', async () => {
    mocks.upsert.mockResolvedValueOnce({ error: { message: 'offline' } });
    const hook = renderHook(() => useFeedPerformance());
    act(() => hook.result.current.track('rpc_latency', 245));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.upsert.mock.calls[1][0]).toEqual(mocks.upsert.mock.calls[0][0]);
    expect(mocks.upsert.mock.calls[0][1]).toEqual({ onConflict: 'id', ignoreDuplicates: true });
  });

  it('drops pending operational telemetry if consent is withdrawn', async () => {
    renderHook(() => useFeedPerformance());
    act(() => emitFeedPerformanceMetric('media_ready', 120));
    mocks.enabled = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
