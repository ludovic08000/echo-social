import { trustedRegion } from '../local-media-location/context.ts';
import type { Commune } from '../local-media-location/communes.ts';
import type { CoarseLocation } from '../local-media-location/location.ts';

export type AdLocation = CoarseLocation & { source: 'profile' | 'network' };
export type AdLocationSnapshot = {
  sessionId: string; revision: string; profileCity: string | null;
  cached: (Omit<CoarseLocation, 'country'> & { country: string | null; source: 'profile' | 'network' | 'unavailable'; expiresAt: string }) | null;
};
const label = (s: string | null) => s && s.length <= 100 && !/[\u0000-\u001f\u007f<>]/.test(s) ? s.trim() || null : null;
const key = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').replace(/[^a-z0-9]/g, '');

// Only configured, gateway-overwritten headers are trusted; never client coordinates or arbitrary IPs.
export function trustedAdZone(headers: Headers, config: {
  enabled: boolean; countryHeader?: string; regionHeader?: string; cityHeader?: string;
}): AdLocation | null {
  const zone = trustedRegion(headers, config);
  if (!zone) return null;
  let city = config.cityHeader ? headers.get(config.cityHeader) : null;
  try { city = city ? decodeURIComponent(city) : null; } catch { city = null; }
  return { ...zone, city: label(city), source: 'network' };
}

export async function resolveAdLocation(profileCity: string | null, search: (q: string) => Promise<Commune[]>,
  network: () => Promise<CoarseLocation | null>): Promise<AdLocation | null> {
  const city = label(profileCity);
  if (city && city.length >= 2) {
    try {
      const matches = (await search(city)).filter(place => key(place.city) === key(city));
      // Homonymous towns are not a reliable city selection.
      if (matches.length === 1) {
        const place = matches[0];
        return { country: place.country, region: place.region, city: place.city, source: 'profile' };
      }
    } catch { /* Fall back without guessing a town or blocking the feed. */ }
  }
  const zone = await network();
  if (!zone || !/^[A-Z]{2}$/.test(zone.country)) return null;
  const region = label(zone.region);
  return { country: zone.country, region, city: region ? label(zone.city) : null, source: 'network' };
}

export function adLocationHandler(deps: {
  enabled: boolean;
  cors: (request: Request) => Record<string, string>;
  authenticate: (authorization: string) => Promise<string | null>;
  allow: (userId: string) => Promise<boolean>;
  snapshot: (authorization: string) => Promise<AdLocationSnapshot | null>;
  search: (query: string) => Promise<Commune[]>;
  network: (headers: Headers) => Promise<CoarseLocation | null>;
  save: (userId: string, snapshot: AdLocationSnapshot, location: AdLocation | null) => Promise<boolean>;
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
      // An empty object is the whole API: consent, identity and location come from the server.
      const reader = request.body?.getReader();
      let text = '';
      if (reader) try {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (value.length > 16 || text.length + value.length > 16) return reply(400, { error: 'INVALID_REQUEST' });
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => undefined); }
      if (text.trim() !== '{}') return reply(400, { error: 'INVALID_REQUEST' });
      if (!deps.enabled) return reply(200, { location: null, reason: 'DISABLED' });
      if (!await deps.allow(userId)) return reply(429, { error: 'RATE_LIMITED' });
      const snapshot = await deps.snapshot(authorization);
      if (!snapshot) return reply(200, { location: null, reason: 'NOT_ELIGIBLE' });
      if (snapshot.cached) return reply(200, { location: snapshot.cached.source === 'unavailable' ? null : snapshot.cached });
      const location = await resolveAdLocation(snapshot.profileCity, deps.search, () => deps.network(request.headers));
      const saved = await deps.save(userId, snapshot, location);
      return reply(200, { location: saved ? location : null, reason: saved ? undefined : 'PREFERENCES_CHANGED' });
    } catch {
      // No tokens, IPs, provider payloads or database details in logs/responses.
      return reply(503, { error: 'AD_LOCATION_UNAVAILABLE' });
    }
  };
}
