import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), invoke: vi.fn(), rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: mocks.session }, functions: { invoke: mocks.invoke }, rpc: mocks.rpc } }));
import { fetchFeedPage, sendFeedEvents, readFeedPreferences, writeFeedPreferences } from '../feedApi';
import { isFeedCursorError } from '../feedPagination';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ data: { session: { user: { id: 'alice' }, access_token: 'alice-test-token' } }, error: null });
  mocks.invoke.mockResolvedValue({ data: { items: [], has_more: false, next_cursor: null }, error: null });
});
it('routes the page through the bounded API with the captured session and no database RPC', async () => {
  await fetchFeedPage(null, 12, 'alice');
  expect(mocks.invoke).toHaveBeenCalledWith('feed-api', expect.objectContaining({ body: { action: 'page', cursor: null, limit: 12 }, headers: { Authorization: 'Bearer alice-test-token' } }));
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('refuses both user switches and authenticated data in a guest cache', async () => {
  await expect(fetchFeedPage(null, 12, 'bob')).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  await expect(fetchFeedPage(null, 12, null)).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('preserves event IDs on retries and sends no user ID or model weights', async () => {
  const events = [{ event_id: 'stable', post_id: 'post', exposure_id: 'proof', event_type: 'view' }];
  mocks.invoke.mockResolvedValueOnce({ error: new Error('network private details') }).mockResolvedValueOnce({ data: { accepted: 1 }, error: null });
  await expect(sendFeedEvents(events, 'alice')).rejects.toMatchObject({ code: 'FEED_UNAVAILABLE' });
  await sendFeedEvents(events, 'alice');
  expect(mocks.invoke.mock.calls.map(call => call[1].body)).toEqual([{ action: 'events', events }, { action: 'events', events }]);
});
it('maps expired cursors without falling back to an unrestricted query', async () => {
  mocks.invoke.mockResolvedValue({ error: { context: new Response(JSON.stringify({ error: { code: 'FEED_CURSOR_EXPIRED', message: 'internal SQL' } }), { status: 409 }) } });
  const error = await fetchFeedPage('cursor', 12, 'alice').catch(error => error);
  expect(isFeedCursorError(error)).toBe(true);
  expect(error.message).not.toContain('SQL');
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('only surfaces known public error codes, including auth/rate limits, not provider details', async () => {
  for (const code of ['FORBIDDEN', 'RATE_LIMITED', 'UNAUTHORIZED', 'DATABASE_SECRET']) {
    mocks.invoke.mockResolvedValue({ error: { context: new Response(JSON.stringify({ error: { code, message: 'secret' } }), { status: 503 }) } });
    await expect(fetchFeedPage(null, 12, 'alice')).rejects.toMatchObject({ code: code === 'DATABASE_SECRET' ? 'FEED_UNAVAILABLE' : code });
  }
});
it('reads preferences only for the current session and refuses an empty successful write', async () => {
  mocks.invoke.mockResolvedValueOnce({ data: { preferences: null }, error: null });
  expect(await readFeedPreferences('alice')).toBeNull();
  await expect(writeFeedPreferences('alice', {} as never)).rejects.toMatchObject({ code: 'FEED_UNAVAILABLE' });
});
