import { getCorsHeaders } from './cors.ts';
import { parseFeedRequest, publicFeedPage, publicPreferences, type FeedPreferences } from './feed-api-contract.ts';

type Result = { data: unknown; error: { code?: string; message?: string } | null };
export interface FeedContext {
  viewerId: string | null;
  rpc(name: 'get_ranked_feed_page' | 'ml_ingest_feed_events', args: Record<string, unknown>): PromiseLike<Result>;
  readPreferences(): PromiseLike<Result>;
  writePreferences(preferences: FeedPreferences, seedOnly: boolean): PromiseLike<Result>;
}
export interface FeedDependencies {
  authenticate(req: Request, signal: AbortSignal): Promise<FeedContext | null>;
  rateLimit(req: Request, viewerId: string | null, action: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response | null>;
}

const MAX_BODY_BYTES = 65536;
const DEADLINE_MS = 10000;

async function readJson(req: Request, signal: AbortSignal) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) throw new Error('UNSUPPORTED_MEDIA_TYPE');
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error('PAYLOAD_TOO_LARGE');
  if (!req.body) throw new Error('INVALID_REQUEST');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { cancel(); throw new Error('PAYLOAD_TOO_LARGE'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('INVALID_REQUEST'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

const ERRORS: Record<string, [number, string]> = {
  INVALID_REQUEST: [400, 'Requête de feed invalide.'],
  UNAUTHORIZED: [401, 'Connectez-vous pour accéder à cette fonction.'],
  FORBIDDEN: [403, 'Accès au feed refusé.'],
  METHOD_NOT_ALLOWED: [405, 'Méthode non autorisée.'],
  FEED_CURSOR_EXPIRED: [409, 'Actualisez le feed pour continuer.'],
  PAYLOAD_TOO_LARGE: [413, 'Requête trop volumineuse.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Format de requête non accepté.'],
  FEED_UNAVAILABLE: [503, 'Le feed est temporairement indisponible.'],
};

export function createFeedHandler(deps: FeedDependencies) {
  return async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const origin = req.headers.get('origin');
    const cors = getCorsHeaders(req);
    // Native app origins are not identities. Every private action still verifies its JWT.
    if (origin && ['capacitor://localhost', 'https://localhost', 'http://localhost'].includes(origin)) cors['Access-Control-Allow-Origin'] = origin;
    const headers = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId };
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
    const fail = (code: string) => {
      const [status, message] = ERRORS[code] ?? ERRORS.FEED_UNAVAILABLE;
      return json({ error: { code, message }, request_id: requestId }, status);
    };
    if (origin && cors['Access-Control-Allow-Origin'] !== origin) return fail('FORBIDDEN');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
    if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<Response>(resolve => {
      timeout = setTimeout(() => { controller.abort(); resolve(fail('FEED_UNAVAILABLE')); }, DEADLINE_MS);
    });
    const work = async (): Promise<Response> => {
      try {
        const input = parseFeedRequest(await readJson(req, controller.signal));
        const context = await deps.authenticate(req, controller.signal);
        if (!context || (input.action !== 'page' && !context.viewerId)) return fail('UNAUTHORIZED');
        controller.signal.throwIfAborted();
        const limited = await deps.rateLimit(req, context.viewerId, input.action, headers, controller.signal);
        if (limited) {
          // A limiter failure must never become permission to continue.
          const status = limited.status === 429 ? 429 : 503;
          return new Response(JSON.stringify({ error: { code: status === 429 ? 'RATE_LIMITED' : 'FEED_UNAVAILABLE',
            message: status === 429 ? 'Trop de requêtes, réessayez plus tard.' : ERRORS.FEED_UNAVAILABLE[1] }, request_id: requestId }),
          { status, headers: { ...headers, 'Retry-After': status === 429 ? '60' : '5' } });
        }
        controller.signal.throwIfAborted();
        const result = input.action === 'page'
          ? await context.rpc('get_ranked_feed_page', { p_limit: input.limit, p_cursor: input.cursor })
          : input.action === 'events'
          ? await context.rpc('ml_ingest_feed_events', { p_events: input.events })
          : input.action === 'preferences.read'
          ? await context.readPreferences()
          : await context.writePreferences(input.preferences, input.action === 'preferences.seed');
        if (result.error) {
          if (input.action === 'page' && result.error.code === '22023' && /feed cursor/i.test(result.error.message ?? '')) return fail('FEED_CURSOR_EXPIRED');
          if (result.error.code === '42501') return fail('FORBIDDEN');
          return fail('FEED_UNAVAILABLE');
        }
        if (input.action === 'page') {
          try { return json({ ...publicFeedPage(result.data, input.limit), request_id: requestId }); }
          catch { return fail('FEED_UNAVAILABLE'); }
        }
        if (input.action === 'events') {
          if (typeof result.data !== 'number' || !Number.isInteger(result.data) || result.data < 0 || result.data > input.events.length) return fail('FEED_UNAVAILABLE');
          return json({ accepted: result.data, request_id: requestId });
        }
        try { return json({ preferences: publicPreferences(result.data), request_id: requestId }); }
        catch { return fail('FEED_UNAVAILABLE'); }
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        return fail(['INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE'].includes(code) ? code : 'FEED_UNAVAILABLE');
      }
    };
    try { return await Promise.race([work(), deadline]); }
    finally { clearTimeout(timeout!); }
  };
}
