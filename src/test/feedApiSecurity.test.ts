// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeedHandler, type FeedContext } from '../../supabase/functions/_shared/feed-api-handler';
import { parseFeedRequest, type FeedPreferences } from '../../supabase/functions/_shared/feed-api-contract';

const id = '00000000-0000-4000-8000-000000000001';
const cursor = '00000000-0000-4000-8000-000000000002';
const preferences: FeedPreferences = {
  feed_algorithm: 'friends_first', ai_summaries_enabled: true, auto_translate_enabled: false,
  diversity_boost: 50, muted_keywords: ['spam'], priority_topics: ['science'], viral_content_reduce: true,
  sensitive_content_filter: true, seen_posts_hide: false, weight_friends: 60, weight_discovery: 30,
  weight_news: 40, weight_marketplace: 10,
};
const page = { items: [{ id, user_id: id, body: 'Bonjour', image_url: 'https://media.example.invalid/image.jpg',
  author_name: 'Compte test', exposure_id: id, final_score: 98, experiment_variant: 'b', rank_reason: 'internal',
  secret_future_field: 'must-not-leak' }], next_cursor: cursor, has_more: true, snapshot_expires_at: '2026-10-26T19:00:00Z',
  query_plan: 'internal-plan' };
const event = { event_id: id, post_id: id, exposure_id: id, event_type: 'view' };

function fixture(viewerId: string | null = id) {
  const rpc = vi.fn().mockResolvedValue({ data: page, error: null });
  const readPreferences = vi.fn().mockResolvedValue({ data: { ...preferences, user_id: id, internal: 'private' }, error: null });
  const writePreferences = vi.fn().mockResolvedValue({ data: preferences, error: null });
  const authenticate = vi.fn().mockResolvedValue({ viewerId, rpc, readPreferences, writePreferences } satisfies FeedContext);
  const rateLimit = vi.fn().mockResolvedValue(null);
  const handle = createFeedHandler({ authenticate, rateLimit });
  const request = (body: unknown = { action: 'page' }, origin = 'https://forsure.fans') => handle(new Request('https://api.example.invalid/feed', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  }));
  return { handle, request, authenticate, rateLimit, rpc, readPreferences, writePreferences };
}
afterEach(() => vi.useRealTimers());

describe('ForSure feed API boundary', () => {
  it('preserves order, media, cursor and exposure while excluding all ranking internals', async () => {
    const f = fixture();
    const response = await f.request({ action: 'page', limit: 12, cursor });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ next_cursor: cursor, has_more: true, items: [{ id, body: 'Bonjour', exposure_id: id, image_url: page.items[0].image_url }] });
    expect(JSON.stringify(body)).not.toMatch(/final_score|experiment_variant|rank_reason|query_plan|secret_future_field/);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('get_ranked_feed_page', { p_limit: 12, p_cursor: cursor });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body.request_id).toBe(response.headers.get('x-request-id'));
  });

  it('keeps public guest pages but forbids guest events and preference reads or writes', async () => {
    const f = fixture(null);
    expect((await f.request()).status).toBe(200);
    f.rpc.mockClear();
    for (const input of [{ action: 'events', events: [event] }, { action: 'preferences.read' },
      { action: 'preferences.write', preferences }, { action: 'preferences.seed', preferences }]) {
      expect((await f.request(input)).status).toBe(401);
    }
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.readPreferences).not.toHaveBeenCalled();
    expect(f.writePreferences).not.toHaveBeenCalled();
  });

  it('does not silently downgrade an invalid session to a guest', async () => {
    const f = fixture(); f.authenticate.mockResolvedValue(null);
    expect((await f.request()).status).toBe(401);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'page', user_id: id }, { action: 'page', limit: 51 }, { action: 'page', limit: 1.5 },
    { action: 'page', cursor: 'offset:50' }, { action: 'rpc', name: 'delete_user' },
    { action: 'events', events: [{ ...event, weight: 999 }] },
    { action: 'events', events: [{ ...event, event_type: 'invented' }] },
    { action: 'events', events: [{ ...event, event_type: ['view'] }] },
    { action: 'events', events: [{ ...event, dwell_ms: 600001 }] },
    { action: 'events', events: Array(101).fill(event) },
    { action: 'preferences.write', preferences: { ...preferences, user_id: id } },
    { action: 'preferences.write', preferences: { ...preferences, weight_friends: 101 } },
    { action: 'preferences.write', preferences: { ...preferences, sensitive_content_filter: 'false' } },
    { action: 'preferences.write', preferences: { ...preferences, feed_algorithm: ['smart'] } },
  ])('rejects unauthorized fields, unbounded values or arbitrary operations: %j', async input => {
    const f = fixture();
    expect((await f.request(input)).status).toBe(400);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('returns a public expired cursor error and never a foreign snapshot or raw SQL message', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'feed cursor is invalid or expired' } });
    const response = await f.request({ action: 'page', cursor });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('FEED_CURSOR_EXPIRED');
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });

  it('never exposes database details and refuses failed quota checks', async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'postgres://secret database-internal' } });
    expect(await (await f.request()).text()).not.toMatch(/postgres|secret|database-internal|XX000/);
    for (const status of [429, 503]) {
      f.rpc.mockClear(); f.rateLimit.mockResolvedValue(new Response('private error', { status }));
      const response = await f.request();
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('private error');
      expect(f.rpc).not.toHaveBeenCalled();
    }
  });

  it('passes only validated event proofs to the existing consent-bound transaction', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ data: 0, error: null });
    const response = await f.request({ action: 'events', events: [event] });
    expect(response.status).toBe(200);
    expect((await response.json()).accepted).toBe(0); // consent withdrawn/replay ignored is legitimate
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('ml_ingest_feed_events', { p_events: [event] });
    expect(parseFeedRequest({ action: 'events', events: [event] })).toEqual({ action: 'events', events: [event] });
  });

  it('uses a separate non-overwriting seed and returns only validated preference fields', async () => {
    const f = fixture();
    expect((await (await f.request({ action: 'preferences.read' })).json()).preferences).toEqual(preferences);
    for (const [action, seed] of [['preferences.seed', true], ['preferences.write', false]] as const) {
      expect((await f.request({ action, preferences })).status).toBe(200);
      expect(f.writePreferences).toHaveBeenLastCalledWith(preferences, seed);
    }
  });

  it('does not permit cross-origin pages, but retains custom domain, preview and native requests', async () => {
    const f = fixture();
    expect((await f.request(undefined, 'https://evil.example')).status).toBe(403);
    expect(f.authenticate).not.toHaveBeenCalled();
    for (const origin of ['https://www.forsure.fans', 'https://calm-connect-05.lovable.app', 'capacitor://localhost', 'https://localhost']) {
      expect((await f.request(undefined, origin)).status).toBe(200);
    }
    expect((await f.handle(new Request('https://api.example.invalid', { method: 'OPTIONS', headers: { Origin: 'https://forsure.fans' } }))).status).toBe(204);
  });

  it('rejects wrong methods, content types, malformed JSON and oversized chunked bodies before querying', async () => {
    const f = fixture();
    expect((await f.handle(new Request('https://api.example.invalid'))).status).toBe(405);
    expect((await f.handle(new Request('https://api.example.invalid', { method: 'POST', body: '{}' }))).status).toBe(415);
    for (const [body, status] of [['{', 400], [' '.repeat(65537), 413]] as const) {
      expect((await f.handle(new Request('https://api.example.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }))).status).toBe(status);
    }
    expect(f.authenticate).not.toHaveBeenCalled();
  });

  it('aborts slow upstream calls at the deadline', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.rpc.mockImplementation(() => new Promise(() => {}));
    const pending = f.request();
    await vi.advanceTimersByTimeAsync(10001);
    expect((await pending).status).toBe(503);
    expect(f.authenticate.mock.calls[0][1].aborted).toBe(true);
  });
});
