import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const SERVICE = 'aegis-server';
const PROTOCOL_VERSION = 2;
const MIN_PROTOCOL_VERSION = 1;

const config = {
  port: intEnv('PORT', 8787, 1, 65535),
  supabaseUrl: requiredEnv('SUPABASE_URL').replace(/\/+$/, ''),
  supabaseAnonKey: requiredEnv('SUPABASE_ANON_KEY'),
  origins: csvEnv('AEGIS_ALLOWED_ORIGINS', process.env.AEGIS_ALLOWED_ORIGIN ?? ''),
  trustProxy: boolEnv('AEGIS_TRUST_PROXY', true),
  authTimeoutMs: intEnv('AEGIS_AUTH_TIMEOUT_MS', 8_000, 1_000, 30_000),
  rpcTimeoutMs: intEnv('AEGIS_REQUEST_TIMEOUT_MS', 20_000, 1_000, 120_000),
  readinessTimeoutMs: intEnv('AEGIS_READINESS_TIMEOUT_MS', 5_000, 500, 30_000),
  maxBodyBytes: intEnv('AEGIS_MAX_BODY_BYTES', 1_048_576, 1_024, 10_485_760),
  rateWindowMs: intEnv('AEGIS_RATE_WINDOW_MS', 60_000, 1_000, 3_600_000),
  ratePerIp: intEnv('AEGIS_RATE_LIMIT_PER_IP', 180, 1, 100_000),
  ratePerUser: intEnv('AEGIS_RATE_LIMIT_PER_USER', 300, 1, 100_000),
  maxConcurrent: intEnv('AEGIS_MAX_CONCURRENT_REQUESTS', 200, 1, 10_000),
  shutdownGraceMs: intEnv('AEGIS_SHUTDOWN_GRACE_MS', 10_000, 1_000, 120_000),
};

const ROUTES = new Map([
  ['/v1/rpc/aegis_send_message', rpcRoute('aegis_send_message', ['p_message_id', 'p_conversation_id', 'p_sender_device_id', 'p_route_version'], 'p_message_id')],
  ['/v1/rpc/aegis_sync_device', rpcRoute('aegis_sync_device', ['p_device_id'], 'p_device_id', 256_000)],
  ['/v1/rpc/aegis_ack_device_messages', rpcRoute('aegis_ack_device_messages', ['p_device_id'], 'p_device_id', 128_000)],
  ['/v2/rpc/aegis_send_message', rpcRoute('aegis_send_message', ['p_message_id', 'p_conversation_id', 'p_sender_device_id', 'p_route_version'], 'p_message_id')],
  ['/v2/rpc/aegis_sync_device', rpcRoute('aegis_sync_device', ['p_device_id'], 'p_device_id', 256_000)],
  ['/v2/rpc/aegis_ack_device_messages', rpcRoute('aegis_ack_device_messages', ['p_device_id'], 'p_device_id', 128_000)],
  ['/v2/rpc/aegis_resolve_conversation_route', rpcRoute('aegis_resolve_conversation_route', ['p_conversation_id', 'p_sender_device_id'], null, 64_000)],
  ['/v2/rpc/aegis_get_device_health', rpcRoute('aegis_get_device_health', ['p_device_id'], null, 32_000)],
  ['/v2/rpc/aegis_enroll_device', rpcRoute('aegis_enroll_device', ['p_device_id', 'p_device_public_key'], 'p_device_id', 512_000)],
  ['/v2/rpc/aegis_publish_prekey_bundle', rpcRoute('aegis_publish_prekey_bundle', ['p_device_id'], 'p_device_id', 768_000)],
  ['/v2/rpc/aegis_repair_current_device', rpcRoute('aegis_repair_current_device', ['p_device_id'], 'p_device_id', 512_000)],
]);

const ipBuckets = new Map();
const userBuckets = new Map();
let inflight = 0;
let shuttingDown = false;
let readinessCache = { at: 0, ok: false, reason: 'not_checked' };

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
function boolEnv(name, fallback) {
  const value = String(process.env[name] ?? fallback).toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}
function csvEnv(name, fallback = '') {
  return new Set(String(process.env[name] ?? fallback).split(',').map((v) => v.trim()).filter(Boolean));
}
function rpcRoute(rpc, required, stableField = null, maxBytes = config.maxBodyBytes) {
  return { rpc, required, stableField, maxBytes };
}
function getRequestId(request) {
  const supplied = String(request.headers['x-request-id'] ?? '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomUUID();
}
function getIp(request) {
  if (config.trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress ?? 'unknown';
}
function allowedOrigin(origin) {
  return config.origins.size === 0 || config.origins.has(origin);
}
function headers(origin, requestId, extra = {}) {
  const allow = allowedOrigin(origin) && origin ? origin : '';
  return {
    ...(allow ? { 'access-control-allow-origin': allow, vary: 'origin' } : {}),
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-aegis-protocol-version, x-request-id',
    'access-control-expose-headers': 'x-aegis-protocol-version, x-request-id, retry-after',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-aegis-protocol-version': String(PROTOCOL_VERSION),
    'x-request-id': requestId,
    ...extra,
  };
}
function send(response, status, payload, origin, requestId, extra = {}) {
  if (response.writableEnded) return;
  response.writeHead(status, headers(origin, requestId, extra));
  response.end(JSON.stringify(payload));
}
function failure(code, message, requestId, options = {}) {
  return { error: { code, message, retryable: options.retryable === true, details: options.details ?? null, hint: options.hint ?? null, request_id: requestId } };
}
function log(level, event, fields = {}) {
  const payload = JSON.stringify({ ts: new Date().toISOString(), level, service: SERVICE, event, ...fields });
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.log(payload);
}
function consume(store, key, limit) {
  const now = Date.now();
  let bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + config.rateWindowMs };
  bucket.count += 1;
  store.set(key, bucket);
  return { allowed: bucket.count <= limit, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}
setInterval(() => {
  const now = Date.now();
  for (const store of [ipBuckets, userBuckets]) for (const [key, bucket] of store) if (bucket.resetAt <= now) store.delete(key);
}, Math.min(config.rateWindowMs, 60_000)).unref();

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function authenticate(authorization) {
  const response = await fetchWithTimeout(`${config.supabaseUrl}/auth/v1/user`, {
    method: 'GET', headers: { apikey: config.supabaseAnonKey, authorization },
  }, config.authTimeoutMs);
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user?.id === 'string' ? user.id : null;
}
async function readJson(request, maxBytes) {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw httpError(415, 'CONTENT_TYPE_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw httpError(400, 'INVALID_JSON'); }
}
function httpError(status, code, details = null) {
  const error = new Error(code);
  error.status = status;
  error.details = details;
  return error;
}
function validateProtocol(request, path) {
  const raw = String(request.headers['x-aegis-protocol-version'] ?? (path.startsWith('/v1/') ? '1' : ''));
  const version = Number(raw);
  if (!Number.isInteger(version) || version < MIN_PROTOCOL_VERSION || version > PROTOCOL_VERSION) {
    throw httpError(426, 'AEGIS_PROTOCOL_VERSION_UNSUPPORTED', { received: raw || null, supported_min: MIN_PROTOCOL_VERSION, supported_max: PROTOCOL_VERSION });
  }
  return version;
}
function validateBody(body, definition) {
  const missing = definition.required.filter((key) => body[key] === undefined || body[key] === null || body[key] === '');
  if (missing.length) throw httpError(400, 'VALIDATION_FAILED', { missing });
}
function stableIdempotencyKey(request, body, definition, userId) {
  const header = String(request.headers['idempotency-key'] ?? '').trim();
  if (header && !/^[A-Za-z0-9._:-]{16,128}$/.test(header)) throw httpError(400, 'INVALID_IDEMPOTENCY_KEY');
  const source = header || (definition.stableField ? String(body[definition.stableField] ?? '') : '');
  if (!source) return null;
  return createHash('sha256').update(`${userId}:${definition.rpc}:${source}`).digest('hex');
}
async function callRpc(definition, body, authorization, requestId, idempotencyHash) {
  const response = await fetchWithTimeout(`${config.supabaseUrl}/rest/v1/rpc/${definition.rpc}`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      authorization,
      'content-type': 'application/json',
      'x-client-info': `${SERVICE}/${PROTOCOL_VERSION}`,
      'x-request-id': requestId,
      ...(idempotencyHash ? { 'idempotency-key': idempotencyHash } : {}),
    },
    body: JSON.stringify(body),
  }, config.rpcTimeoutMs);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { message: text.slice(0, 500) }; }
  return { response, data };
}
function safeText(value) {
  return typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').slice(0, 500) : null;
}
function sanitizeDetails(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return safeText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeDetails(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    out[key] = /key|secret|token|authorization|cipher|body|plaintext/i.test(key) ? '[REDACTED]' : sanitizeDetails(item, depth + 1);
  }
  return out;
}
function publicRpcMessage(code, fallback) {
  const known = {
    PARTICIPANT_DEVICE_SETUP_REQUIRED: 'Le destinataire doit terminer la sécurisation de son appareil.',
    E2EE_PARTICIPANT_ROUTE_UNAVAILABLE: 'Un participant ne possède actuellement aucun appareil sécurisé disponible.',
    SENDER_DEVICE_NOT_ROUTABLE: 'Cet appareil doit être réparé avant de pouvoir envoyer des messages.',
    PREKEY_BUNDLE_INCOMPLETE: 'Le canal sécurisé est en cours de préparation.',
    E2EE_DEVICE_LIST_STALE: 'La liste des appareils a changé. Une nouvelle tentative est nécessaire.',
  };
  return known[code] ?? safeText(fallback) ?? 'Aegis database rejected the request.';
}
function normalizeUpstream(status, data, requestId) {
  const code = String(data?.code ?? `UPSTREAM_${status}`);
  const retryableCodes = new Set(['40001', '40P01', '57014', 'PGRST003', 'PARTICIPANT_DEVICE_SETUP_REQUIRED', 'E2EE_PARTICIPANT_ROUTE_UNAVAILABLE', 'SENDER_DEVICE_NOT_ROUTABLE', 'PREKEY_BUNDLE_INCOMPLETE', 'E2EE_DEVICE_LIST_STALE']);
  return failure(code, publicRpcMessage(code, data?.message), requestId, {
    retryable: status >= 500 || [408, 409, 429].includes(status) || retryableCodes.has(code),
    details: sanitizeDetails(data?.details),
    hint: safeText(data?.hint),
  });
}
async function readiness() {
  const now = Date.now();
  if (now - readinessCache.at < 5_000) return readinessCache;
  try {
    const response = await fetchWithTimeout(`${config.supabaseUrl}/rest/v1/`, { headers: { apikey: config.supabaseAnonKey } }, config.readinessTimeoutMs);
    readinessCache = { at: now, ok: response.status < 500, reason: response.status < 500 ? 'ok' : `supabase_${response.status}` };
  } catch (error) {
    readinessCache = { at: now, ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
  return readinessCache;
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  const requestId = getRequestId(request);
  const origin = String(request.headers.origin ?? '');
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const definition = ROUTES.get(path);
  const ip = getIp(request);
  response.setHeader('connection', 'close');

  if (request.method === 'OPTIONS') {
    if (!allowedOrigin(origin)) return send(response, 403, failure('ORIGIN_DENIED', 'Origin denied.', requestId), origin, requestId);
    response.writeHead(204, headers(origin, requestId));
    return response.end();
  }
  if (request.method === 'GET' && path === '/health/live') {
    return send(response, shuttingDown ? 503 : 200, { ok: !shuttingDown, service: SERVICE, protocol_version: PROTOCOL_VERSION, uptime_seconds: Math.floor(process.uptime()) }, origin, requestId);
  }
  if (request.method === 'GET' && path === '/health/ready') {
    const state = shuttingDown ? { ok: false, reason: 'shutting_down' } : await readiness();
    return send(response, state.ok ? 200 : 503, { ok: state.ok, service: SERVICE, dependency: 'supabase', reason: state.reason, protocol_version: PROTOCOL_VERSION }, origin, requestId);
  }
  if (shuttingDown) return send(response, 503, failure('SERVER_SHUTTING_DOWN', 'Server is shutting down.', requestId, { retryable: true }), origin, requestId, { 'retry-after': '5' });
  if (request.method !== 'POST' || !definition) return send(response, 404, failure('NOT_FOUND', 'Unknown route.', requestId), origin, requestId);
  if (origin && !allowedOrigin(origin)) return send(response, 403, failure('ORIGIN_DENIED', 'Origin denied.', requestId), origin, requestId);

  const ipRate = consume(ipBuckets, ip, config.ratePerIp);
  if (!ipRate.allowed) return send(response, 429, failure('RATE_LIMITED', 'Too many requests.', requestId, { retryable: true }), origin, requestId, { 'retry-after': String(ipRate.retryAfter) });
  if (inflight >= config.maxConcurrent) return send(response, 503, failure('SERVER_BUSY', 'Aegis is temporarily busy.', requestId, { retryable: true }), origin, requestId, { 'retry-after': '1' });

  const authorization = String(request.headers.authorization ?? '');
  if (!authorization.startsWith('Bearer ')) return send(response, 401, failure('NOT_AUTHENTICATED', 'Bearer token required.', requestId), origin, requestId);

  inflight += 1;
  let userId = null;
  try {
    const protocolVersion = validateProtocol(request, path);
    userId = await authenticate(authorization);
    if (!userId) return send(response, 401, failure('INVALID_SESSION', 'Session expired or invalid.', requestId), origin, requestId);

    const userRate = consume(userBuckets, userId, config.ratePerUser);
    if (!userRate.allowed) return send(response, 429, failure('RATE_LIMITED', 'Too many requests.', requestId, { retryable: true }), origin, requestId, { 'retry-after': String(userRate.retryAfter) });

    const body = await readJson(request, definition.maxBytes);
    validateBody(body, definition);
    const idempotencyHash = stableIdempotencyKey(request, body, definition, userId);
    const { response: upstream, data } = await callRpc(definition, body, authorization, requestId, idempotencyHash);

    if (!upstream.ok) {
      const normalized = normalizeUpstream(upstream.status, data, requestId);
      log('warn', 'rpc_rejected', { request_id: requestId, rpc: definition.rpc, user_id: userId, status: upstream.status, code: normalized.error.code, retryable: normalized.error.retryable, duration_ms: Date.now() - startedAt });
      return send(response, upstream.status, normalized, origin, requestId);
    }

    log('info', 'rpc_completed', { request_id: requestId, rpc: definition.rpc, user_id: userId, status: 200, protocol_version: protocolVersion, duration_ms: Date.now() - startedAt });
    return send(response, 200, { data, error: null, meta: { request_id: requestId, protocol_version: PROTOCOL_VERSION } }, origin, requestId);
  } catch (error) {
    const status = Number(error?.status) || (error?.name === 'AbortError' ? 504 : 502);
    const code = error?.message || 'AEGIS_GATEWAY_FAILURE';
    const messages = {
      BODY_TOO_LARGE: 'Request body is too large.', INVALID_JSON: 'Request body must be valid JSON.', CONTENT_TYPE_REQUIRED: 'Content-Type application/json is required.',
      VALIDATION_FAILED: 'Required request fields are missing.', INVALID_IDEMPOTENCY_KEY: 'Idempotency-Key is invalid.',
      AEGIS_PROTOCOL_VERSION_UNSUPPORTED: 'This client protocol version is not supported.', UPSTREAM_TIMEOUT: 'Aegis did not receive a response in time.',
    };
    log(status >= 500 ? 'error' : 'warn', 'request_failed', { request_id: requestId, user_id: userId, path, status, code, duration_ms: Date.now() - startedAt });
    return send(response, status, failure(code, messages[code] ?? 'Aegis gateway could not complete the request.', requestId, { retryable: status >= 500, details: error?.details ?? null }), origin, requestId, status === 426 ? { upgrade: `aegis/${PROTOCOL_VERSION}` } : {});
  } finally {
    inflight -= 1;
  }
});

server.requestTimeout = config.rpcTimeoutMs + config.authTimeoutMs + 5_000;
server.headersTimeout = Math.min(server.requestTimeout, 30_000);
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(config.port, '0.0.0.0', () => log('info', 'server_started', { port: config.port, protocol_version: PROTOCOL_VERSION, allowed_origin_count: config.origins.size }));

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('warn', 'shutdown_started', { signal, inflight });
  server.close((error) => {
    if (error) { log('error', 'shutdown_failed', { signal, message: safeText(error.message) }); process.exitCode = 1; }
    else log('info', 'shutdown_complete', { signal });
  });
  setTimeout(() => { log('error', 'shutdown_forced', { signal, inflight }); process.exit(1); }, config.shutdownGraceMs).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => { log('error', 'uncaught_exception', { name: error?.name, message: safeText(error?.message) }); shutdown('uncaughtException'); });
process.on('unhandledRejection', (reason) => log('error', 'unhandled_rejection', { message: safeText(reason instanceof Error ? reason.message : String(reason)) }));
