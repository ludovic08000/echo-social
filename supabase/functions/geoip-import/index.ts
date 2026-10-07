import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

Deno.serve(async (request) => {
  if (request.method !== 'PUT') return json(405, { error: 'METHOD_NOT_ALLOWED' });
  if (Deno.env.get('DBIP_IMPORT_ENABLED') !== 'true') return json(404, { error: 'DISABLED' });
  const expected = Deno.env.get('DBIP_IMPORT_TOKEN');
  if (!expected || request.headers.get('authorization') !== `Bearer ${expected}`) {
    return json(401, { error: 'UNAUTHORIZED' });
  }
  const release = request.headers.get('x-dbip-release') ?? '';
  const name = request.headers.get('x-dbip-file') ?? '';
  if (!/^\d{4}-(0[1-9]|1[0-2])-[a-f0-9]{12}$/.test(release)
    || !/^(manifest|[a-f0-9]{64})\.json$/.test(name)) return json(400, { error: 'INVALID_PATH' });
  const length = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(length) || length < 1 || length > 8 * 1024 * 1024) {
    return json(413, { error: 'INVALID_SIZE' });
  }
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json(503, { error: 'NOT_CONFIGURED' });
  const bytes = new Uint8Array(await request.arrayBuffer());
  const client = createClient(url, key, { auth: { persistSession: false } });
  const path = `${release}/${name}`;
  const { error } = await client.storage.from('geoip-lite').upload(path, bytes, {
    contentType: 'application/json', upsert: false,
  });
  if (error && !/already exists/i.test(error.message)) return json(502, { error: 'UPLOAD_FAILED' });
  return json(200, { ok: true, path, bytes: bytes.byteLength, existing: Boolean(error) });
});
