import { fetchRss, type FetchResult, type RssSource } from './rss.ts';

type Result = FetchResult | { status: 'failure'; items: []; etag: null; last_modified: null; error: string };
export interface RssJobDeps {
  secret: string | undefined; enabled: boolean;
  claim(): Promise<RssSource[]>;
  finish(source: RssSource, result: Result): Promise<boolean>;
  fetch?: typeof fetch;
}
const errorCodes = new Set(['SOURCE_NOT_VERIFIED', 'PARTNER_RIGHTS_REQUIRED', 'FEED_TOO_LARGE', 'UNSAFE_XML', 'INVALID_XML', 'UNSUPPORTED_FEED', 'TOO_MANY_ITEMS', 'FETCH_FAILED', 'UNEXPECTED_NOT_MODIFIED', 'FEED_RESPONSE_REJECTED', 'EMPTY_RESPONSE', 'INVALID_ENCODING']);
errorCodes.add('SOURCE_COVERAGE_MISMATCH');
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function authorized(supplied: string | null, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 32 || !supplied || supplied.length > 256) return false;
  const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([hash(supplied), hash(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export function rssHandler(deps: RssJobDeps) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    if (!await authorized(request.headers.get('x-media-cron-secret'), deps.secret)) return json({ error: 'UNAUTHORIZED' }, 401);
    if (!deps.enabled) return json({ status: 'disabled' });
    // The caller cannot select an URL, partner, approval or item. DB leases own the work.
    let sources: RssSource[];
    try { sources = await deps.claim(); } catch { return json({ error: 'CLAIM_FAILED' }, 503); }
    if (sources.length > 20) return json({ error: 'BATCH_LIMIT_EXCEEDED' }, 503);
    const counts = { sources: sources.length, success: 0, not_modified: 0, failure: 0, stale: 0 };
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
      while (cursor < sources.length) {
        const source = sources[cursor++]; let result: Result;
        try { result = await fetchRss(source, deps.fetch); }
        catch (error) {
          const code = error instanceof Error && errorCodes.has(error.message) ? error.message : 'FETCH_FAILED';
          result = { status: 'failure', items: [], etag: null, last_modified: null, error: code };
        }
        try {
          if (!await deps.finish(source, result)) counts.stale++;
          else counts[result.status]++;
        } catch { counts.failure++; }
      }
    }));
    return json(counts, counts.failure ? 207 : 200);
  };
}
