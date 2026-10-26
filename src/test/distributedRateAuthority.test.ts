// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const compile = (file: string) => ts.transpileModule(
  readFileSync(`supabase/functions/${file}`, 'utf8').replace(/^import[^;]+;\r?\n/gm, ''),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const env = { env: { get: () => 'synthetic-config' } };
function limiter(rpc: ReturnType<typeof vi.fn>) {
  return new Function('exports', 'Deno', 'createClient', 'console',
    compile('_shared/rate-limit.ts') + ';return exports.checkRateLimit;',
  )({}, env, () => ({ rpc }), quiet);
}

it.each([null, undefined, 'true', 1, {}])('does not interpret a malformed quota response as authorization: %j', async data => {
  const quota = limiter(vi.fn().mockResolvedValue({ data, error: null }));
  const response = await quota('owner', 5, 60, { 'Access-Control-Allow-Origin': 'https://forsure.fans' });
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('5');
});
it('distinguishes authorization, exhaustion and infrastructure errors without disabling future checks', async () => {
  const rpc = vi.fn()
    .mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function public.check_rate_limit' } })
    .mockResolvedValueOnce({ data: false, error: null })
    .mockResolvedValueOnce({ data: true, error: null })
    .mockRejectedValueOnce(new Error('network unavailable'));
  const quota = limiter(rpc);
  expect((await quota('owner', 5, 60, {})).status).toBe(503);
  expect((await quota('owner', 5, 60, {})).status).toBe(429);
  expect(await quota('owner', 5, 60, {})).toBeNull();
  expect((await quota('owner', 5, 60, {})).status).toBe(503);
  expect(rpc).toHaveBeenCalledTimes(4);
});

const definitions = ['ai-engine', 'ad-assistant', 'ai-content', 'post-assistant', 'photo-guard', 'seller-ai-coach', 'create-tip', 'zeus'];
it.each(definitions)('the actual %s handler stops before external spending when quota fails', async name => {
  let handler: (req: Request) => Promise<Response> = async () => new Response();
  const quota = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
  const fetch = vi.fn();
  const user = { id: 'synthetic-user', email: 'user@example.invalid' };
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_creator: true }, error: null }) }) }) }),
  };
  new Function('Deno', 'serve', 'createClient', 'getCorsHeaders', 'checkRateLimitDB', 'fetch', 'console', compile(`${name}/index.ts`))(
    { ...env, serve: (fn: typeof handler) => { handler = fn; } },
    (fn: typeof handler) => { handler = fn; }, () => client, () => ({}), quota, fetch, quiet,
  );
  const response = await handler(new Request('https://local.invalid', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'content', action: 'correct', text: 'Bonjour' }),
  }));
  expect(response.status).toBe(503);
  expect(quota).toHaveBeenCalledOnce();
  expect(quota.mock.calls[0][0]).toBe(name === 'zeus' ? 'zeus:synthetic-user:content' : `${name}:synthetic-user`);
  expect(fetch).not.toHaveBeenCalled();
});

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(readFileSync('supabase/migrations/20260507094108_9c495355-28ff-4a06-b712-a0fbf91e0b2f.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261018205651_harden_distributed_rate_limit_authority.sql', 'utf8'));
}, 30000);
beforeEach(async () => { await db.exec('reset role;truncate edge_rate_limits;set role service_role;'); });
afterAll(async () => { await db?.close(); });
const count = (key = 'same-user', max: number | null = 3, window: number | null = 60) =>
  db.query<{ allowed: boolean }>('select check_rate_limit($1,$2,$3) as allowed', [key, max, window]);

it('keeps the SQL quota and counters unavailable to browser roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await expect(count()).rejects.toThrow(/permission denied/);
    await expect(db.query('select * from edge_rate_limits')).rejects.toThrow(/permission denied/);
  }
});
it('counts requests through separate limiter instances against the same atomic database authority', async () => {
  const rpc = vi.fn(async (_: string, args: Record<string, unknown>) => {
    const result = await db.query<{ allowed: boolean }>('select check_rate_limit($1,$2,$3) as allowed', [args.p_key, args.p_max_requests, args.p_window_seconds]);
    return { data: result.rows[0].allowed, error: null };
  });
  const first = limiter(rpc), second = limiter(rpc);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second)('same-user', 3, 60, {})));
  expect(results.filter(r => r === null)).toHaveLength(3);
  expect(results.filter(r => r?.status === 429)).toHaveLength(9);
});
it('resets only an expired window and keeps identities separate', async () => {
  await count('owner', 1); expect((await count('owner', 1)).rows[0].allowed).toBe(false);
  expect((await count('other', 1)).rows[0].allowed).toBe(true);
  await db.query("update edge_rate_limits set window_start=now()-interval '61 seconds' where key='owner'");
  expect((await count('owner', 1)).rows[0].allowed).toBe(true);
});
it('rejects invalid parameters and never converts a SQL failure into success', async () => {
  await expect(count('', 1)).rejects.toThrow('INVALID_RATE_LIMIT_PARAMETERS');
  await expect(count('owner', null)).rejects.toThrow('INVALID_RATE_LIMIT_PARAMETERS');
  await expect(count('owner', 1, 0)).rejects.toThrow('INVALID_RATE_LIMIT_PARAMETERS');
  await db.exec('reset role;alter table edge_rate_limits add constraint force_failure check(count<1);set role service_role;');
  try { await expect(count()).rejects.toThrow(/force_failure/); }
  finally { await db.exec('reset role;alter table edge_rate_limits drop constraint force_failure;'); }
});
