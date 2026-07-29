import { createServer } from 'node:http';

const port = Number(process.env.PORT || 8787);
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '');
const allowedOrigins = new Set(
  String(process.env.AEGIS_ALLOWED_ORIGINS || process.env.AEGIS_ALLOWED_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const maxBodyBytes = Number(process.env.AEGIS_MAX_BODY_BYTES || 1_048_576);

const routes = new Map([
  ['/v1/rpc/aegis_send_message', 'aegis_send_message'],
  ['/v1/rpc/aegis_sync_device', 'aegis_sync_device'],
  ['/v1/rpc/aegis_ack_device_messages', 'aegis_ack_device_messages'],
]);

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
}

function corsHeaders(origin) {
  const allowed = allowedOrigins.has(origin) ? origin : '';
  return {
    ...(allowed ? { 'access-control-allow-origin': allowed } : {}),
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  };
}

function send(response, status, payload, origin = '') {
  response.writeHead(status, corsHeaders(origin));
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

createServer(async (request, response) => {
  const origin = String(request.headers.origin || '');
  if (request.method === 'OPTIONS') {
    if (!allowedOrigins.has(origin)) return send(response, 403, { error: 'origin_denied' });
    response.writeHead(204, corsHeaders(origin));
    return response.end();
  }

  if (request.method === 'GET' && request.url === '/health') {
    return send(response, 200, { ok: true, service: 'aegis-server' }, origin);
  }

  const rpcName = routes.get(request.url || '');
  if (request.method !== 'POST' || !rpcName) {
    return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route.' } }, origin);
  }
  if (allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
    return send(response, 403, { error: { code: 'ORIGIN_DENIED', message: 'Origin denied.' } }, origin);
  }

  const authorization = String(request.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) {
    return send(response, 401, {
      error: { code: 'NOT_AUTHENTICATED', message: 'Bearer token required.' },
    }, origin);
  }

  try {
    const body = await readJson(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const upstream = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    const text = await upstream.text();
    const data = text ? JSON.parse(text) : null;
    if (!upstream.ok) {
      return send(response, upstream.status, {
        error: {
          code: data?.code || `UPSTREAM_${upstream.status}`,
          message: data?.message || 'Aegis database rejected the request.',
          details: data?.details || null,
          hint: data?.hint || null,
        },
      }, origin);
    }
    return send(response, 200, { data, error: null }, origin);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'BODY_TOO_LARGE';
    return send(response, tooLarge ? 413 : 502, {
      error: {
        code: tooLarge ? 'BODY_TOO_LARGE' : 'AEGIS_GATEWAY_FAILURE',
        message: error instanceof Error ? error.message : String(error),
      },
    }, origin);
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`[aegis-server] listening on :${port}`);
});
