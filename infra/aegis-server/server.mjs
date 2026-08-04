import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const SERVICE = 'aegis-server';
const PROTOCOL_VERSION = 2;
const MIN_PROTOCOL_VERSION = 2;
const port = integerEnv('PORT', 8787, 1, 65535);
const supabaseUrl = requiredEnv('SUPABASE_URL').replace(/\/+$/, '');
const supabaseAnonKey = requiredEnv('SUPABASE_ANON_KEY');
const allowedOrigins = csvSet('AEGIS_ALLOWED_ORIGINS', process.env.AEGIS_ALLOWED_ORIGIN ?? '');
const trustProxy = boolEnv('AEGIS_TRUST_PROXY', true);
const requestTimeoutMs = integerEnv('AEGIS_REQUEST_TIMEOUT_MS', 20_000, 1_000, 120_000);
const authTimeoutMs = integerEnv('AEGIS_AUTH_TIMEOUT_MS', 8_000, 1_000, 30_000);
const readinessTimeoutMs = integerEnv('AEGIS_READINESS_TIMEOUT_MS', 5_000, 500, 30_000);
const maxBodyBytes = integerEnv('AEGIS_MAX_BODY_BYTES', 1_048_576, 1_024, 10_485_760);
const rateWindowMs = integerEnv('AEGIS_RATE_WINDOW_MS', 60_000, 1_000, 3_600_000);
const rateLimitPerIp = integerEnv('AEGIS_RATE_LIMIT_PER_IP', 180, 1, 100_000);
const rateLimitPerUser = integerEnv('AEGIS_RATE_LIMIT_PER_USER', 300, 1, 100_000);
const maxConcurrent = integerEnv('AEGIS_MAX_CONCURRENT_REQUESTS', 200, 1, 10_000);
const shutdownGraceMs = integerEnv('AEGIS_SHUTDOWN_GRACE_MS', 10_000, 1_000, 120_000);

const routes = new Map([
  ['/v2/rpc/aegis_send_message', route('aegis_send_message', {
    maxBytes: maxBodyBytes,
    idempotent: true,
    required: ['p_message_id', 'p_conversation_id', 'p_sender_device_id', 'p_route_version'],
  })],
  ['/v2/rpc/aegis_sync_device', route('aegis_sync_device', {
    maxBytes: 256_000,
    idempotent: true,
    required: ['p_device_id'],
  })],
  ['/v2/rpc/aegis_ack_device_messages', route('aegis_ack_device_messages', {
    maxBytes: 128_000,
    idempotent: true,
    required: ['p_device_id'],
  })],
  ['/v2/rpc/aegis_resolve_conversation_route', route('aegis_resolve_conversation_route', {
    maxBytes: 64_000,
    required: ['p_conversation_id', 'p_sender_device_id'],
  })],
  ['/v2/rpc/aegis_get_device_health', route('aegis_get_device_health', {
    maxBytes: 32_000,
    required: ['p_device_id'],
  })],
  ['/v2/rpc/aegis_enroll_device', route('aegis_enroll_device', {
    maxBytes: 512_000,
    idempotent: true,
    required: ['p_device_id', 'p_device_public_key'],
  })],
  ['/v2/rpc/aegis_publish_prekey_bundle', route('aegis_publish_prekey_bundle', {
    maxBytes: 768_000,
    idempotent: true,
    required: ['p_device_id'],
  })],
  ['/v2/rpc/aegis_repair_current_device', route('aegis_repair_current_device', {
    maxBytes: 512_000,
    idempotent: true,
    required: ['p_device_id'],
  })],
]);

// Temporary v1 compatibility. It accepts only the original three routes and
// tells the caller which protocol should be adopted. Remove after every active
// web/mobile client advertises protocol v2.
const legacyRoutes = new Map([
  ['/v1/rpc/aegis_send_message', routes.get('/v2/rpc/aegis_send_message')],
  ['/v1/rpc/aegis_sync_device', routes.get('/v2/rpc/aegis_sync_device')],
  ['/v1/rpc/aegis_ack_device_messages', routes.get('/v2/rpc/aegis_ack_device_messages')],
]);

const ipBuckets = new Map();
const userBuckets = new Map();
let inflight = 0;
let shuttingDown = false;
let readyCache = { checkedAt: 0, ok: false, reason: 'not_checked' };

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name, fallback, min, max) {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return raw;
}

function boolEnv(name, fallback) {
  const raw = String(process.env[name] ?? fallback).toLowerCase();
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function csvSet(name, fallback = '') {
  return new Set(String(process.env[name] ?? fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

function route(rpc, options = {}) {
  return {
    rpc,
    maxBytes: options.maxBytes ?? maxBodyBytes,
    idempotent: options.idempotent === true,
    required: options.required ?? [],
  };
}

function requestId(request) {
  const supplied = String(request.headers['x-request-id'] ?? '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomUUID();
}

function remoteIp(request) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function corsHeaders(origin, requestIdValue, legacy = false) {
  const allowed = allowedOrigins.size === 0 || allowedOrigins.has(origin) ? origin : '';
  return {
    ...(allowed ? { 'access-control-allow-origin': allowed } : {}),
    ...(allowed ? { vary: 'origin' } : {}),
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-aegis-protocol-version, x-request-id',
    'access-control-expose-headers': 'x-aegis-protocol-version, x-request-id, retry-after',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-aegis-protocol-version': String(PROTOCOL_VERSION),
    'x-request-id': requestIdValue,
    ...(legacy ? { deprecation: 'true', sunset: 'Wed, 04 Nov 2026 00:00:00 GMT' } : {}),
  };
}

function send(response, status, payload, context = {}) {
  if (response.writableEnded) return;
  const headers = { ...corsHeaders(context.origin ?? '', context.requestId ?? randomUUID(), context.legacy), ...(context.headers ?? {}) };
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function apiError(code, message, options = {}) {
  return {
    error: {
      code,
      message,
      retryable: options.retryable === true,
      details: options.details ?? null,
      hint: options.hint ?? null,
      request_id: options.requestId ?? null,
    },
  };
}

function log(level, event, fields = {}) {
  const safe = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    event,
    ...fields,
  };
  // Never log authorization headers, request bodies, plaintext, ciphertext or keys.
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(safe));
}

function consumeBucket(store, key, limit) {
  const now = Date.now();
  let bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + rateWindowMs };
    store.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function cleanupBuckets() {
  const now = Date.now();
  for (const store of [ipBuckets, userBuckets]) {
    for (const [key, bucket] of store) {
      if (bucket.resetAt <= now) store.delete(key);
    }
  }
}
setInterval(cleanupBuckets, Math.min(rateWindowMs, 60_000)).unref();

async function readJson(request, limit) {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    const error = new Error('CONTENT_TYPE_REQUIRED');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('BODY_TOO_LARGE');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('object required');
    return parsed;
  } catch {
    const error = new Error('INVALID_JSON');
    error.status = 400;
    throw error;
  }
}

function validateBody(body, definition) {
  const missing = definition.required.filter((key) => body[key] === undefined || body[key] === null || body[key] === '');
  if (missing.length > 0) {
    const error = new Error('VALIDATION_FAILED');
    error.status = 400;
    error.details = { missing };
    throw error;
  }
}

function validateProtocol(request, legacy) {
  if (legacy) return;
  const raw = String(request.headers['x-aegis-protocol-version'] ?? '');
  const version = Number(raw);
  if (!Number.isInteger(version) || version < MIN_PROTOCOL_VERSION || version > PROTOCOL_VERSION) {
    const error = new Error('AEGIS_PROTOCOL_VERSION_UNSUPPORTED');
    error.status = 426;
    error.details = { supported_min: MIN_PROTOCOL_VERSION, supported_max: PROTOCOL_VERSION, received: raw || null };
    throw error;
  }
}

function validateIdempotency(request, definition) {
  if (!definition.idempotent) return null;
  const key = String(request.headers['idempotency-key'] ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    const error = new Error('IDEMPOTENCY_KEY_REQUIRED');
    error.status = 400;
    throw error;
  }
  return key;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function authenticate(authorization) {
  const response = await fetchWithTimeout(`${supabaseUrl}/auth/v1/user`, {
    method: 'GET',
    headers: { apikey: supabaseAnonKey, authorization },
  }, authTimeoutMs);
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user?.id === 'string' ? { id: user.id } : null;
}

async function callRpc(definition, body, authorization, requestIdValue, idempotencyKey) {
  const upstream = await fetchWithTimeout(`${supabaseUrl}/rest/v1/rpc/${definition.rpc}`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      authorization,
      'content-type': 'application/json',
      'x-client-info': `${SERVICE}/${PROTOCOL_VERSION}`,
      'x-request-id': requestIdValue,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  }, requestTimeoutMs);

  const text = await upstream.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 500) }; }
  return { upstream, data };
}

function normalizeUpstreamError(status, data, requestIdValue) {
  const rawCode = String(data?.code ?? `UPSTREAM_${status}`);
  const rawMessage = String(data?.message ?? 'Aegis database rejected the request.');
  const knownRetryable = new Set([
    '40001', '40P01', '57014', 'PGRST003',
    'E2EE_DEVICE_LIST_STALE', 'PARTICIPANT_DEVICE_SETUP_REQUIRED',
    'SENDER_DEVICE_NOT_ROUTABLE', 'PREKEY_BUNDLE_INCOMPLETE',
  ]);
  const retryable = status >= 500 || status === 408 || status === 409 || status === 429 || knownRetryable.has(rawCode);
  return apiError(rawCode, publicMessage(rawCode, rawMessage), {
    retryable,
    details: sanitizeDetails(data?.details),
    hint: sanitizeText(data?.hint),
    requestId: requestIdValue,
  });
}

function publicMessage(code, fallback) {
  const messages = {
    PARTICIPANT_DEVICE_SETUP_REQUIRED: 'Le destinataire doit terminer la sécurisation de son appareil.',
    SENDER_DEVICE_NOT_ROUTABLE: 'Cet appareil doit être réparé avant de pouvoir envoyer des messages.',
    PREKEY_BUNDLE_INCOMPLETE: 'Le canal sécurisé est en cours de préparation.',
    E2EE_DEVICE_LIST_STALE: 'La liste des appareils a changé. Une nouvelle tentative est nécessaire.',
    E2EE_PARTICIPANT_ROUTE_UNAVAILABLE: 'Un participant ne possède actuellement aucun appareil sécurisé disponible.',
  };
  return messages[code] ?? sanitizeText(fallback) ?? 'Aegis database rejected the request.';
}

function sanitizeText(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

function sanitizeDetails(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeText(value);
  // Details can contain participant/device identifiers but must never contain keys.
  if (typeof value === 'object') {
    const json = JSON.stringify(value, (key, item) =>
      /key|secret|token|authorization|cipher|body|plaintext/i.test(key) ? '[REDACTED]' : item,
    );
    return JSON.parse(json.slice(0, 4_000));
  }
  return String(value).slice(0, 500);
}

async function readiness() {
  const now = Date.now();
  if (now - readyCache.checkedAt < 5_000) return readyCache;
  try {
    const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: supabaseAnonKey },
    }, readinessTimeoutMs);
    readyCache = {
      checkedAt: now,
      ok: response.status < 500,
      reason: response.status < 500 ? 'ok' : `supabase_${response.status}`,
    };
  } catch (error) {
    readyCache = { checkedAt: now, ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
  return readyCache;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  const id = requestId(request);
  const origin = String(request.headers.origin ?? '');
  const ip = remoteIp(request);
  const url = new URL(request.url ?? '/', 'http://localhost');
  const legacy = legacyRoutes.has(url.pathname);
  const definition = routes.get(url.pathname) ?? legacyRoutes.get(url.pathname);
  const context = { requestId: id, origin, legacy };

  response.setHeader('connection', 'close');

  if (request.method === 'OPTIONS') {
    if (allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      return send(response, 403, apiError('ORIGIN_DENIED', 'Origin denied.', { requestId: id }), context);
    }
    response.writeHead(204, corsHeaders(origin, id, legacy));
    return response.end();
  }

  if (request.method === 'GET' && url.pathname === '/health/live') {
    return send(response, shuttingDown ? 503 : 200, {
      ok: !shuttingDown,
      service: SERVICE,
      protocol_version: PROTOCOL_VERSION,
      uptime_seconds: Math.floor(process.uptime()),
    }, context);
  }

  if (request.method === 'GET' && url.pathname === '/health/ready') {
    const status = shuttingDown ? { ok: false, reason: 'shutting_down' } : await readiness();
    return send(response, status.ok ? 200 : 503, {
      ok: status.ok,
      service: SERVICE,
      dependency: 'supabase',
      reason: status.reason,
      protocol_version: PROTOCOL_VERSION,
    }, context);
  }

  if (shuttingDown) {
    return send(response, 503, apiError('SERVER_SHUTTING_DOWN', 'Server is shutting down.', { retryable: true, requestId: id }), {
      ...context,
      headers: { 'retry-after': '5' },
    });
  }

  if (request.method !== 'POST' || !definition) {
    return send(response, 404, apiError('NOT_FOUND', 'Unknown route.', { requestId: id }), context);
  }

  if (allowedOrigins.size > 0 && origin && !allowedOrigins.has(origin)) {
    return send(response, 403, apiError('ORIGIN_DENIED', 'Origin denied.', { requestId: id }), context);
  }

  const ipRate = consumeBucket(ipBuckets, ip, rateLimitPerIp);
  if (!ipRate.allowed) {
    return send(response, 429, apiError('RATE_LIMITED', 'Too many requests.', { retryable: true, requestId: id }), {
      ...context,
      headers: { 'retry-after': String(ipRate.retryAfterSeconds) },
    });
  }

  if (inflight >= maxConcurrent) {
    return send(response, 503, apiError('SERVER_BUSY', 'Aegis is temporarily busy.', { retryable: true, requestId: id }), {
      ...context,
      headers: { 'retry-after': '1' },
    });
  }

  const authorization = String(request.headers.authorization ?? '');
  if (!authorization.startsWith('Bearer ')) {
    return send(response, 401, apiError('NOT_AUTHENTICATED', 'Bearer token required.', { requestId: id }), context);
  }

  inflight += 1;
  let userId = null;
  try {
    validateProtocol(request, legacy);
    const idempotencyKey = validateIdempotency(request, definition);
    const user = await authenticate(authorization);
    if (!user) {
      return send(response, 401, apiError('INVALID_SESSION', 'Session expired or invalid.', { requestId: id }), context);
    }
    userId = user.id;

    const userRate = consumeBucket(userBuckets, user.id, rateLimitPerUser);
    if (!userRate.allowed) {
      return send(response, 429, apiError('RATE_LIMITED', 'Too many requests.', { retryable: true, requestId: id }), {
        ...context,
        headers: { 'retry-after': String(userRate.retryAfterSeconds) },
      });
    }

    const body = await readJson(request, definition.maxBytes);
    validateBody(body, definition);

    // Bind idempotent RPC calls to both user and route without exposing the raw
    // key in logs. PostgreSQL remains responsible for durable deduplication.
    if (idempotencyKey) {
      body.p_idempotency_key ??= createHash('sha256')
        .update(`${user.id}:${definition.rpc}:${idempotencyKey}`)
        .digest('hex');
    }
    body.p_protocol_version ??= PROTOCOL_VERSION;
    body.p_request_id ??= id;

    const { upstream, data } = await callRpc(definition, body, authorization, id, idempotencyKey);
    if (!upstream.ok) {
      const normalized = normalizeUpstreamError(upstream.status, data, id);
      log('warn', 'rpc_rejected', {
        request_id: id,
        rpc: definition.rpc,
        user_id: user.id,
        status: upstream.status,
        code: normalized.error.code,
        retryable: normalized.error.retryable,
        duration_ms: Date.now() - startedAt,
      });
      return send(response, upstream.status, normalized, context);
    }

    log('info', 'rpc_completed', {
      request_id: id,
      rpc: definition.rpc,
      user_id: user.id,
      status: 200,
      duration_ms: Date.now() - startedAt,
      legacy,
    });
    return send(response, 200, {
      data,
      error: null,
      meta: {
        request_id: id,
        protocol_version: PROTOCOL_VERSION,
        legacy,
      },
    }, context);
  } catch (error) {
    const status = Number(error?.status) || (error?.name === 'AbortError' ? 504 : 502);
    const code = error?.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE'
      : error?.message === 'INVALID_JSON' ? 'INVALID_JSON'
      : error?.message === 'CONTENT_TYPE_REQUIRED' ? 'CONTENT_TYPE_REQUIRED'
      : error?.message === 'VALIDATION_FAILED' ? 'VALIDATION_FAILED'
      : error?.message === 'IDEMPOTENCY_KEY_REQUIRED' ? 'IDEMPOTENCY_KEY_REQUIRED'
      : error?.message === 'AEGIS_PROTOCOL_VERSION_UNSUPPORTED' ? 'AEGIS_PROTOCOL_VERSION_UNSUPPORTED'
      : error?.name === 'AbortError' ? 'UPSTREAM_TIMEOUT'
      : 'AEGIS_GATEWAY_FAILURE';
    const retryable = status >= 500 && code !== 'AEGIS_PROTOCOL_VERSION_UNSUPPORTED';
    log(status >= 500 ? 'error' : 'warn', 'request_failed', {
      request_id: id,
      user_id: userId,
      path: url.pathname,
      status,
      code,
      duration_ms: Date.now() - startedAt,
    });
    return send(response, status, apiError(code, publicGatewayMessage(code), {
      retryable,
      details: error?.details ?? null,
      requestId: id,
    }), {
      ...context,
      headers: status === 426 ? { upgrade: `aegis/${PROTOCOL_VERSION}` } : {},
    });
  } finally {
    inflight -= 1;
  }
});

function publicGatewayMessage(code) {
  const messages = {
    BODY_TOO_LARGE: 'Request body is too large.',
    INVALID_JSON: 'Request body must be valid JSON.',
    CONTENT_TYPE_REQUIRED: 'Content-Type application/json is required.',
    VALIDATION_FAILED: 'Required request fields are missing.',
    IDEMPOTENCY_KEY_REQUIRED: 'A valid Idempotency-Key header is required.',
    AEGIS_PROTOCOL_VERSION_UNSUPPORTED: 'This client protocol version is not supported.',
    UPSTREAM_TIMEOUT: 'Aegis did not receive a response in time.',
    AEGIS_GATEWAY_FAILURE: 'Aegis gateway could not complete the request.',
  };
  return messages[code] ?? 'Aegis gateway could not complete the request.';
}

server.requestTimeout = requestTimeoutMs + authTimeoutMs + 5_000;
server.headersTimeout = Math.min(server.requestTimeout, 30_000);
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

server.listen(port, '0.0.0.0', () => {
  log('info', 'server_started', {
    port,
    protocol_version: PROTOCOL_VERSION,
    allowed_origin_count: allowedOrigins.size,
    max_body_bytes: maxBodyBytes,
  });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('warn', 'shutdown_started', { signal, inflight });
  server.close((error) => {
    if (error) {
      log('error', 'shutdown_failed', { signal, message: sanitizeText(error.message) });
      process.exitCode = 1;
    } else {
      log('info', 'shutdown_complete', { signal });
    }
  });
  setTimeout(() => {
    log('error', 'shutdown_forced', { signal, inflight });
    process.exit(1);
  }, shutdownGraceMs).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  log('error', 'uncaught_exception', { message: sanitizeText(error?.message), name: error?.name });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled_rejection', { message: sanitizeText(reason instanceof Error ? reason.message : String(reason)) });
});
