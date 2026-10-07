import { createDbipLookup } from './dbip-lite.ts';

/** Private objects in the EXISTING Lovable Cloud storage; no public geolocation endpoint or paid API. */
export function dbipFromCloud(env: (name: string) => string | undefined, fetchImpl: typeof fetch = fetch) {
  const release = env('DBIP_LITE_RELEASE');
  const hash = env('DBIP_LITE_MANIFEST_SHA256');
  const base = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (env('DBIP_LITE_ENABLED') !== 'true' || !release || !/^\d{4}-(0[1-9]|1[0-2])-[a-f0-9]{12}$/.test(release)
    || !hash || !/^[a-f0-9]{64}$/.test(hash) || !key || !base || !/^https:\/\/[a-z0-9.-]+\/?$/.test(base)) return async () => null;
  return createDbipLookup({ manifestSha256: hash, read: async (file, limit, signal) => {
    const response = await fetchImpl(`${base.replace(/\/$/, '')}/storage/v1/object/authenticated/geoip-lite/${release}/${file}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal, redirect: 'error',
    });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) throw new Error('GEO_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error('GEO_UNAVAILABLE');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } });
}
