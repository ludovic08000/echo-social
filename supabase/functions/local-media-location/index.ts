import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.0';
import { getCorsHeaders } from '../_shared/cors.ts';
import { locationHandler, trustedLocationIp } from './location.ts';
import { dbipFromCloud } from '../_shared/dbip-storage.ts';
import { searchCommunes } from './communes.ts';
import { resolveMediaContext, trustedRegion } from './context.ts';

const url = Deno.env.get('SUPABASE_URL')!; // Existing Lovable Cloud runtime variables.
const lookup = dbipFromCloud(name => Deno.env.get(name));
const locate = (headers: Headers) => {
  const ip = trustedLocationIp(headers, Deno.env.get('LOCAL_MEDIA_TRUSTED_IP_HEADER'));
  return ip ? lookup(ip, headers.get('accept-language') ?? '') : Promise.resolve(null);
};
const options = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, {
    ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(5000)]),
  }) },
};
Deno.serve(locationHandler({
  cors: getCorsHeaders,
  authenticate: async (authorization) => {
    const client = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, options);
    const { data, error } = await client.auth.getUser(authorization.replace(/^Bearer /i, ''));
    return error ? null : data.user?.id ?? null;
  },
  allow: async (userId, kind) => {
    const client = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, options);
    const { data, error } = await client.rpc('check_rate_limit', {
      p_key: `local-media-location:${kind}:${userId}`, p_max_requests: kind === 'ip' ? 5 : 30, p_window_seconds: kind === 'ip' ? 3600 : 60,
    });
    return !error && data === true; // Fail closed if limiter is down.
  },
  search: searchCommunes,
  context: async (userId, headers) => {
    // Enable only after documenting purpose/legal basis and trusted proxy configuration in Lovable.
    const enabled = Deno.env.get('LOCAL_MEDIA_CONTEXT_ENABLED') === 'true';
    if (!enabled) return null;
    const client = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, options);
    const { data: preferences, error } = await client.from('discovery_preferences')
      .select('local_media,country,region,city').eq('user_id', userId).maybeSingle();
    if (error || preferences?.local_media === false) return null;
    const { data: profile } = preferences?.region ? { data: null } : await client.from('profiles').select('city').eq('user_id', userId).maybeSingle();
    return resolveMediaContext({ enabled, preferences, profileCity: profile?.city ?? null, search: searchCommunes,
      network: async () => {
        const zone = trustedRegion(headers, { enabled,
          countryHeader: Deno.env.get('LOCAL_MEDIA_TRUSTED_GEO_COUNTRY_HEADER'),
          regionHeader: Deno.env.get('LOCAL_MEDIA_TRUSTED_GEO_REGION_HEADER'),
        });
        if (zone) return zone;
        const estimated = await locate(headers);
        return estimated?.region ? { ...estimated, region: estimated.region, source: 'network' as const } : null;
      },
    });
  },
  locate,
}));
