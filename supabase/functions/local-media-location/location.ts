import { normalizePublicIp } from '../_shared/network-context.ts';
import type { Commune } from '../_shared/communes.ts';

export interface CoarseLocation { country: string; region: string | null; city: string | null }
const clean = (value: unknown) => typeof value === 'string' && value.trim().length <= 100
  && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? value.trim() || null : null;

/** Disabled until the operator confirms which header the Lovable gateway overwrites. */
export function trustedLocationIp(headers: Headers, configuredHeader?: string): string | null {
  if (!configuredHeader || !['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'].includes(configuredHeader)) return null;
  const raw = headers.get(configuredHeader);
  const value = configuredHeader === 'x-forwarded-for' ? raw?.split(',').at(-1)?.trim() : raw;
  const ip = normalizePublicIp(value);
  // Only global-unicast IPv6; do not send mapped/private or multicast ranges.
  return ip?.includes(':') && !/^[23][0-9a-f]{3}:/.test(ip) ? null : ip;
}

export function locationHandler(deps: {
  authenticate: (authorization: string) => Promise<string | null>;
  allow: (userId: string, kind: 'ip' | 'city') => Promise<boolean>;
  locate: (headers: Headers) => Promise<CoarseLocation | null>;
  search?: (query: string) => Promise<Commune[]>;
  context?: (userId: string, headers: Headers) => Promise<unknown>;
  cors: (request: Request) => Record<string, string>;
}) {
  return async (request: Request): Promise<Response> => {
    const headers = { ...deps.cors(request), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (request.method !== 'POST') return reply(405, { error: 'METHOD_NOT_ALLOWED' });
    try {
      const authorization = request.headers.get('authorization') ?? '';
      if (!/^Bearer \S+$/i.test(authorization)) return reply(401, { error: 'AUTH_REQUIRED' });
      const userId = await deps.authenticate(authorization);
      if (!userId) return reply(401, { error: 'AUTH_REQUIRED' });
      // Only an opt-in or a town query; never an arbitrary IP, URL or user ID.
      if (Number(request.headers.get('content-length') || 0) > 1024) return reply(413, { error: 'BODY_TOO_LARGE' });
      const reader = request.body?.getReader();
      if (!reader) return reply(400, { error: 'CONSENT_REQUIRED' });
      let bytes = new Uint8Array();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (bytes.length + value.length > 1024) return reply(413, { error: 'BODY_TOO_LARGE' });
          const next = new Uint8Array(bytes.length + value.length); next.set(bytes); next.set(value, bytes.length); bytes = next;
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (body?.context === true && Object.keys(body).length === 1) {
        if (!await deps.allow(userId, 'city')) return reply(429, { error: 'RATE_LIMITED' });
        return reply(200, { location: deps.context ? await deps.context(userId, request.headers) : null });
      }
      if (typeof body?.cityQuery === 'string' && Object.keys(body).length === 1) {
        const query = clean(body.cityQuery);
        if (!query || query.length < 2) return reply(400, { error: 'INVALID_CITY_QUERY' });
        if (!await deps.allow(userId, 'city')) return reply(429, { error: 'RATE_LIMITED' });
        if (!deps.search) return reply(503, { error: 'CITY_SEARCH_UNAVAILABLE' });
        return reply(200, { cities: await deps.search(query) });
      }
      if (bytes.length > 64) return reply(413, { error: 'BODY_TOO_LARGE' });
      if (body?.consent !== true || Object.keys(body).length !== 1) return reply(400, { error: 'CONSENT_REQUIRED' });
      if (!await deps.allow(userId, 'ip')) return reply(429, { error: 'RATE_LIMITED' });
      const result = await deps.locate(request.headers);
      return result ? reply(200, result) : reply(503, { error: 'MANUAL_LOCATION_REQUIRED' });
    } catch { return reply(503, { error: 'LOCATION_UNAVAILABLE' }); }
  };
}
