import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const mocks = vi.hoisted(() => ({ fetchPage: vi.fn(), sync: vi.fn(), metric: vi.fn(), user: { id: 'alice' } as { id: string } | null }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock('@/lib/feedApi', () => ({ fetchFeedPage: mocks.fetchPage }));
vi.mock('@/lib/feedPreferences', () => ({ syncFeedPrefsFromServer: mocks.sync }));
vi.mock('@/hooks/useFeedPerformance', () => ({ emitFeedPerformanceMetric: mocks.metric }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { usePosts } from '../usePosts';

const response = (id: string, cursor: string | null) => ({ items: [{ id, user_id: 'creator', body: 'Science',
  image_url: 'https://image.example.invalid/photo.jpg', author_name: 'Auteur', exposure_id: `proof-${id}`,
  user_reaction: 'like', created_at: '2026-10-26T00:00:00Z' }], next_cursor: cursor, has_more: !!cursor,
  snapshot_expires_at: new Date(Date.now() + 1800000).toISOString() });
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.user = { id: 'alice' }; mocks.sync.mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); });

it('renders the first page and preserves server cursors, proofs and media on following pages', async () => {
  mocks.fetchPage.mockResolvedValueOnce(response('one', 'opaque-next')).mockResolvedValueOnce(response('two', null));
  const hook = renderHook(() => usePosts(), { wrapper });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(mocks.fetchPage).toHaveBeenNthCalledWith(1, null, 12, 'alice');
  expect(hook.result.current.data?.pages[0][0]).toMatchObject({ id: 'one', exposure_id: 'proof-one', profile: { name: 'Auteur' } });
  await act(async () => { await hook.result.current.fetchNextPage(); });
  expect(mocks.fetchPage).toHaveBeenNthCalledWith(2, 'opaque-next', 12, 'alice');
  await waitFor(() => expect(hook.result.current.data?.pages.flat().map(p => p.id)).toEqual(['one', 'two']));
  expect(hook.result.current.hasNextPage).toBe(false);
});

it('does not blend an expired page with a newly computed feed or retry it silently', async () => {
  mocks.fetchPage.mockRejectedValue({ code: 'FEED_CURSOR_EXPIRED' });
  const hook = renderHook(() => usePosts(), { wrapper });
  await waitFor(() => expect(hook.result.current.snapshotExpired).toBe(true));
  expect(mocks.fetchPage).toHaveBeenCalledTimes(1);
  expect(hook.result.current.data).toBeUndefined();
});

it('keeps guest rendering separate and never displays another account reaction', async () => {
  mocks.user = null; mocks.fetchPage.mockResolvedValue(response('public', null));
  const hook = renderHook(() => usePosts(), { wrapper });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(mocks.fetchPage).toHaveBeenCalledWith(null, 12, null);
  expect(hook.result.current.data?.pages[0][0]).toMatchObject({ is_liked: false, user_reaction: null });
});
