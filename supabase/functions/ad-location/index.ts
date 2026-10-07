import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.0';
import { getCorsHeaders } from '../_shared/cors.ts';
import { searchCommunes } from '../_shared/communes.ts';
import { trustedLocationIp } from '../_shared/media-location.ts';
import { dbipFromCloud } from '../_shared/dbip-storage.ts';
import { adLocationHandler, trustedAdZone, type AdLocationSnapshot } from './context.ts';

const url = Deno.env.get('SUPABASE_URL')!; // Existing Lovable Cloud backend, no new project.
const options = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, {
    ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(5000)]),
  }) },
};
const service = () => createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, options);
const enabled = Deno.env.get('ADS_LOCATION_AUTO_ENABLED') === 'true';
const lookup = dbipFromCloud(name => Deno.env.get(name));
Deno.serve(adLocationHandler({
  enabled, cors: getCorsHeaders,
  authenticate: async authorization => {
    const client = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, options);
    const { data, error } = await client.auth.getUser(authorization.replace(/^Bearer /i, ''));
    return error ? null : data.user?.id ?? null;
  },
  allow: async userId => {
    const { data, error } = await service().rpc('check_rate_limit', {
      p_key: `ad-location:${userId}`, p_max_requests: 12, p_window_seconds: 3600,
    });
    return !error && data === true;
  },
  snapshot: async authorization => {
    const client = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      ...options, global: { ...options.global, headers: { Authorization: authorization } },
    });
    const { data, error } = await client.rpc('get_my_ad_location_context');
    if (error) throw new Error('CONTEXT_UNAVAILABLE');
    return data as AdLocationSnapshot | null;
  },
  search: searchCommunes,
  network: async headers => {
    const zone = trustedAdZone(headers, { enabled,
      countryHeader: Deno.env.get('ADS_LOCATION_TRUSTED_GEO_COUNTRY_HEADER'),
      regionHeader: Deno.env.get('ADS_LOCATION_TRUSTED_GEO_REGION_HEADER'),
      cityHeader: Deno.env.get('ADS_LOCATION_TRUSTED_GEO_CITY_HEADER'),
    });
    if (zone) return zone; // Region-only stays region-only; no extra third-party request.
    const ip = trustedLocationIp(headers, Deno.env.get('ADS_LOCATION_TRUSTED_IP_HEADER'));
    return ip ? await lookup(ip, headers.get('accept-language') ?? '') : null;
  },
  save: async (userId, snapshot, location) => {
    const { data, error } = await service().rpc('store_ad_location_context', {
      p_user: userId, p_session: snapshot.sessionId, p_revision: snapshot.revision,
      p_country: location?.country ?? null, p_region: location?.region ?? null,
      p_city: location?.city ?? null, p_source: location?.source ?? 'unavailable',
    });
    if (error) throw new Error('CONTEXT_UNAVAILABLE');
    return data === true;
  },
}));
