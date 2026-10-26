// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { PREFERENCE_FIELDS } from '../../supabase/functions/_shared/feed-api-contract';
import { createFeedHandler, type FeedDependencies } from '../../supabase/functions/_shared/feed-api-handler';

function fixture() {
  let deps: FeedDependencies;
  const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-viewer', role: 'authenticated' } }, error: null });
  const read = vi.fn().mockResolvedValue({ data: { feed_algorithm: 'chronological' }, error: null });
  const upsert = vi.fn();
  const eq = vi.fn();
  const chain = { select: vi.fn(), upsert, eq, maybeSingle: read };
  chain.select.mockReturnValue(chain); upsert.mockReturnValue(chain); eq.mockReturnValue(chain);
  const caller = { auth: { getUser }, rpc: vi.fn().mockImplementation(async (name: string) => ({
    data: name === 'feed_api_session_active' ? true : {}, error: null,
  })), from: vi.fn().mockReturnValue(chain) };
  const quota = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }), from: vi.fn() };
  const createClient = vi.fn((_url: string, key: string, _options?: unknown) => key === 'server-secret' ? quota : caller);
  const code = ts.transpileModule(readFileSync('supabase/functions/feed-api/index.ts', 'utf8').replace(/^import[^;]+;\r?\n/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('Deno', 'createClient', 'createFeedHandler', 'PREFERENCE_FIELDS', code)(
    { env: { get: (name: string) => ({ SUPABASE_URL: 'https://test.example.invalid', SUPABASE_ANON_KEY: 'public-key', SUPABASE_SERVICE_ROLE_KEY: 'server-secret' })[name] }, serve: () => {} },
    createClient, (value: FeedDependencies) => { deps = value; }, PREFERENCE_FIELDS,
  );
  const request = (token?: string) => new Request('https://test.example.invalid', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { deps: deps!, caller, quota, createClient, getUser, read, eq, upsert, request };
}

it('verifies the token with Auth and runs all content operations using the caller JWT', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  const ctx = await f.deps.authenticate(f.request('user-token'), signal);
  expect(f.getUser).toHaveBeenCalledExactlyOnceWith('user-token');
  expect(f.caller.rpc).toHaveBeenCalledExactlyOnceWith('feed_api_session_active');
  expect(ctx?.viewerId).toBe('verified-viewer');
  expect(f.createClient.mock.calls[0][1]).toBe('public-key');
  expect(f.createClient.mock.calls[0][2]).toMatchObject({ global: { headers: { Authorization: 'Bearer user-token' } }, auth: { persistSession: false } });
  await ctx!.rpc('get_ranked_feed_page', { p_limit: 12, p_cursor: null });
  await ctx!.readPreferences();
  expect(f.eq).toHaveBeenCalledWith('user_id', 'verified-viewer');
  expect(f.quota.from).not.toHaveBeenCalled();
});

it('does not accept forged, privileged or deleted-user tokens as a guest', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  for (const response of [{ data: { user: null }, error: { message: 'bad jwt', status: 401 } },
    { data: { user: { id: 'attacker', role: 'service_role' } }, error: null }]) {
    f.getUser.mockResolvedValueOnce(response);
    expect(await f.deps.authenticate(f.request('forged'), signal)).toBeNull();
  }
  expect(f.caller.from).not.toHaveBeenCalled();
  expect(f.caller.rpc).not.toHaveBeenCalled();
});

it('does not classify temporary Auth outages as invalid sessions', async () => {
  const f = fixture();
  for (const status of [0, 429, 500, 503]) {
    f.getUser.mockResolvedValueOnce({ data: { user: null }, error: { status, message: 'private provider detail' } });
    await expect(f.deps.authenticate(f.request('valid-user-token'), new AbortController().signal))
      .rejects.toThrow('FEED_UNAVAILABLE');
  }
  expect(f.caller.rpc).not.toHaveBeenCalled();
});

it('retains genuine guest requests with only the public application key', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  expect((await f.deps.authenticate(f.request(), signal))?.viewerId).toBeNull();
  expect((await f.deps.authenticate(f.request('public-key'), signal))?.viewerId).toBeNull();
  expect(f.getUser).not.toHaveBeenCalled();
  expect(f.caller.rpc).not.toHaveBeenCalled();
  expect(f.createClient.mock.calls.every(call => call[1] === 'public-key')).toBe(true);
});

it('checks revocation again on every request instead of caching an earlier approval', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  expect((await f.deps.authenticate(f.request('user-token'), signal))?.viewerId).toBe('verified-viewer');
  f.caller.rpc.mockResolvedValueOnce({ data: false, error: null });
  expect(await f.deps.authenticate(f.request('user-token'), signal)).toBeNull();
  expect(f.caller.rpc.mock.calls.map(call => call[0])).toEqual(['feed_api_session_active', 'feed_api_session_active']);
});

it.each([
  { data: null, error: { code: '42883', message: 'private missing migration' } },
  { data: null, error: { code: 'XX000', message: 'private database unavailable' } },
  { data: null, error: null }, { data: 'true', error: null }, { data: [true], error: null },
])('fails closed without treating a session-check outage as revocation: %j', async result => {
  const f = fixture(); f.caller.rpc.mockResolvedValueOnce(result);
  const response = await createFeedHandler(f.deps)(new Request('https://test.example.invalid', {
    method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'page' }),
  }));
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body.error.code).toBe('FEED_UNAVAILABLE');
  expect(JSON.stringify(body)).not.toMatch(/private|42883|XX000|database/);
  expect(f.caller.rpc.mock.calls.map(call => call[0])).toEqual(['feed_api_session_active']);
  expect(f.caller.from).not.toHaveBeenCalled();
  expect(f.quota.rpc).not.toHaveBeenCalled();
});

it.each(['page', 'events', 'preferences.read', 'preferences.write', 'preferences.seed'])(
  'blocks revoked sessions before executing %s and never falls back to public data', async action => {
    const f = fixture(); f.caller.rpc.mockResolvedValueOnce({ data: false, error: null });
    const id = '00000000-0000-4000-8000-000000000001';
    const input = action === 'events'
      ? { action, events: [{ event_id: id, post_id: id, exposure_id: id, event_type: 'view' }] }
      : action === 'preferences.write' || action === 'preferences.seed'
      ? { action, preferences: { feed_algorithm: 'smart', ai_summaries_enabled: true, auto_translate_enabled: false,
        diversity_boost: 50, muted_keywords: [], priority_topics: [], viral_content_reduce: true,
        sensitive_content_filter: true, seen_posts_hide: false, weight_friends: 50, weight_discovery: 50,
        weight_news: 50, weight_marketplace: 50 } }
      : { action };
    const response = await createFeedHandler(f.deps)(new Request('https://test.example.invalid', {
      method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
    expect(f.caller.rpc.mock.calls.map(call => call[0])).toEqual(['feed_api_session_active']);
    expect(f.caller.from).not.toHaveBeenCalled();
    expect(f.quota.rpc).not.toHaveBeenCalled();
  },
);

it('binds preference owner server-side and re-reads after a concurrent non-overwriting seed', async () => {
  const f = fixture();
  const ctx = await f.deps.authenticate(f.request('user-token'), new AbortController().signal);
  f.read.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: { feed_algorithm: 'chronological' }, error: null });
  const result = await ctx!.writePreferences({ feed_algorithm: 'smart' } as never, true);
  expect(f.upsert).toHaveBeenCalledWith({ user_id: 'verified-viewer', feed_algorithm: 'smart' }, { onConflict: 'user_id', ignoreDuplicates: true });
  expect(result.data).toEqual({ feed_algorithm: 'chronological' });
});

it('keeps service authority isolated to bounded persistent quotas and refuses unknown outcomes', async () => {
  const f = fixture(); const req = f.request('user-token'); const signal = new AbortController().signal;
  expect(await f.deps.rateLimit(req, 'verified-viewer', 'page', {}, signal)).toBeNull();
  expect(f.quota.rpc).toHaveBeenLastCalledWith('check_rate_limit', { p_key: 'feed-api:user:verified-viewer:page', p_max_requests: 120, p_window_seconds: 60 });
  f.quota.rpc.mockResolvedValueOnce({ data: null, error: null });
  expect((await f.deps.rateLimit(req, 'verified-viewer', 'page', {}, signal))?.status).toBe(503);
  f.quota.rpc.mockResolvedValueOnce({ data: false, error: null });
  expect((await f.deps.rateLimit(req, 'verified-viewer', 'page', {}, signal))?.status).toBe(429);
  expect(f.quota.from).not.toHaveBeenCalled();
});

it('applies a non-rotatable guest ceiling even when IP headers change', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  for (const ip of ['192.0.2.1', '198.51.100.2']) {
    await f.deps.rateLimit(new Request('https://test.example.invalid', { headers: { 'x-forwarded-for': ip } }), null, 'page', {}, signal);
  }
  const budgets = f.quota.rpc.mock.calls.map(call => call[1]);
  expect(budgets.filter(b => b.p_key === 'feed-api:guest-global:page')).toEqual([
    { p_key: 'feed-api:guest-global:page', p_max_requests: 600, p_window_seconds: 60 },
    { p_key: 'feed-api:guest-global:page', p_max_requests: 600, p_window_seconds: 60 },
  ]);
  expect(JSON.stringify(budgets)).not.toMatch(/192\.0\.2|198\.51\.100/);
  f.quota.rpc.mockClear();
  f.quota.rpc.mockResolvedValueOnce({ data: false, error: null });
  expect((await f.deps.rateLimit(f.request(), null, 'page', {}, signal))?.status).toBe(429);
  expect(f.quota.rpc).toHaveBeenCalledTimes(1); // No per-IP rows once the global ceiling is reached.
});
