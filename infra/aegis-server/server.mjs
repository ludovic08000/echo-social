import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROUTES = new Map([
  ['/v1/rpc/aegis_send_message', 'aegis_send_message'],
  ['/v1/rpc/aegis_sync_device', 'aegis_sync_device'],
  ['/v1/rpc/aegis_ack_device_messages', 'aegis_ack_device_messages'],
]);

export class GatewayError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}

function parsePositiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), minimum), maximum);
}

function parseList(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizeSupabaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('SUPABASE_URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('SUPABASE_URL must be a valid HTTP(S) URL without embedded credentials');
  }
  return raw;
}

export function loadAegisConfig(env = process.env) {
  const supabaseUrl = normalizeSupabaseUrl(env.SUPABASE_URL);
  const supabaseAnonKey = String(env.SUPABASE_ANON_KEY || '').trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  }

  return {
    port: parsePositiveInteger(env.PORT, 8787, 0, 65_535),
    supabaseUrl,
    supabaseAnonKey,
    allowedOrigins: parseList(env.AEGIS_ALLOWED_ORIGINS || env.AEGIS_ALLOWED_ORIGIN),
    allowedHosts: parseList(env.AEGIS_ALLOWED_HOSTS || env.AEGIS_ALLOWED_HOST),
    maxBodyBytes: parsePositiveInteger(env.AEGIS_MAX_BODY_BYTES, 1_048_576, 1_024, 10_485_760),
    upstreamTimeoutMs: parsePositiveInteger(env.AEGIS_UPSTREAM_TIMEOUT_MS, 20_000, 100, 120_000),
  };
}

function normalizeRequestId(value) {
  const candidate = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : randomUUID();
}

function pathnameOf(requestUrl) {
  try {
    return new URL(requestUrl || '/', 'http://aegis.local').pathname;
  } catch {
    return '/';
  }
}

function normalizedHost(value) {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '');
}

function hostAllowed(config, host) {
  return !config.allowedHosts || config.allowedHosts.size === 0
    || config.allowedHosts.has(normalizedHost(host));
}

function originAllowed(config, origin) {
  const normalizedOrigin = String(origin || '').trim().toLowerCase();
  if (!normalizedOrigin) return true;
  return config.allowedOrigins.size > 0 && config.allowedOrigins.has(normalizedOrigin);
}

function corsHeaders(config, origin, requestId) {
  const normalizedOrigin = String(origin || '').trim().toLowerCase();
  const allowed = normalizedOrigin && config.allowedOrigins.has(normalizedOrigin) ? origin : '';
  return {
    ...(allowed ? { 'access-control-allow-origin': allowed, vary: 'Origin' } : {}),
    'access-control-allow-headers': 'authorization, content-type, x-request-id',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-expose-headers': 'x-request-id',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
  };
}

function writeJson(response, config, origin, requestId, status, payload) {
  response.writeHead(status, corsHeaders(config, origin, requestId));
  response.end(JSON.stringify(payload));
}

function parsedBodyToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  try {
    return Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  } catch {
    throw new GatewayError('INVALID_JSON', 400, 'Request body must be valid JSON.');
  }
}

function decodeJsonBuffer(raw) {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new GatewayError('INVALID_JSON', 400, 'Request body must be valid JSON.');
  }
}

async function readJson(request, maxBodyBytes) {
  if (request.body !== undefined) {
    const raw = parsedBodyToBuffer(request.body);
    if (raw.length > maxBodyBytes) {
      throw new GatewayError('BODY_TOO_LARGE', 413, 'Request body exceeds the configured limit.');
    }
    return { body: decodeJsonBuffer(raw), bodyBytes: raw.length };
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new GatewayError('BODY_TOO_LARGE', 413, 'Request body exceeds the configured limit.');
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks);
  return { body: decodeJsonBuffer(raw), bodyBytes: size };
}

function parseUpstreamPayload(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function defaultLogger(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function logRecord(logger, level, event, fields = {}) {
  try {
    logger({ timestamp: new Date().toISOString(), level, event, ...fields });
  } catch {
    // Logging must never change the HTTP response or crash the gateway.
  }
}

function hasValidBearerToken(value) {
  const authorization = String(value || '');
  if (!authorization.startsWith('Bearer ')) return false;
  const token = authorization.slice(7);
  return token.length > 0 && !/\s/.test(token);
}

export async function handleAegisRequest(request, response, {
  config = loadAegisConfig(),
  fetchImpl = globalThis.fetch,
  logger = defaultLogger,
  pathOverride,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  const startedAt = performance.now();
  const requestId = normalizeRequestId(request.headers?.['x-request-id']);
  const origin = String(request.headers?.origin || '');
  const host = normalizedHost(request.headers?.host || request.headers?.['x-forwarded-host']);
  const path = pathOverride || pathnameOf(request.url);
  const rpcName = ROUTES.get(path) || null;
  let bodyBytes = 0;
  let status = 500;
  let errorCode = null;
  let upstreamStatus = null;

  const finishLog = () => {
    logRecord(logger, status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request_complete', {
      request_id: requestId,
      method: request.method || 'UNKNOWN',
      path,
      rpc: rpcName,
      status,
      upstream_status: upstreamStatus,
      duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      body_bytes: bodyBytes,
      origin_allowed: originAllowed(config, origin),
      host_allowed: hostAllowed(config, host),
      error_code: errorCode,
    });
  };

  try {
    if (!hostAllowed(config, host)) {
      status = 404;
      errorCode = 'NOT_FOUND';
      writeJson(response, config, origin, requestId, status, {
        error: { code: errorCode, message: 'Unknown route.' },
        request_id: requestId,
      });
      return;
    }

    if (request.method === 'OPTIONS') {
      if (!rpcName) {
        status = 404;
        errorCode = 'NOT_FOUND';
        writeJson(response, config, origin, requestId, status, {
          error: { code: errorCode, message: 'Unknown route.' },
          request_id: requestId,
        });
        return;
      }
      if (!origin || !originAllowed(config, origin)) {
        status = 403;
        errorCode = 'ORIGIN_DENIED';
        writeJson(response, config, origin, requestId, status, {
          error: { code: errorCode, message: 'Origin denied.' },
          request_id: requestId,
        });
        return;
      }
      status = 204;
      response.writeHead(status, corsHeaders(config, origin, requestId));
      response.end();
      return;
    }

    if (request.method === 'GET' && path === '/health') {
      status = 200;
      writeJson(response, config, origin, requestId, status, {
        ok: true,
        service: 'aegis-server',
        request_id: requestId,
      });
      return;
    }

    if (request.method !== 'POST' || !rpcName) {
      status = 404;
      errorCode = 'NOT_FOUND';
      writeJson(response, config, origin, requestId, status, {
        error: { code: errorCode, message: 'Unknown route.' },
        request_id: requestId,
      });
      return;
    }

    if (!originAllowed(config, origin)) {
      status = 403;
      errorCode = 'ORIGIN_DENIED';
      writeJson(response, config, origin, requestId, status, {
        error: { code: errorCode, message: 'Origin denied.' },
        request_id: requestId,
      });
      return;
    }

    const authorization = String(request.headers?.authorization || '');
    if (!hasValidBearerToken(authorization)) {
      status = 401;
      errorCode = 'NOT_AUTHENTICATED';
      writeJson(response, config, origin, requestId, status, {
        error: { code: errorCode, message: 'Bearer token required.' },
        request_id: requestId,
      });
      return;
    }

    const parsed = await readJson(request, config.maxBodyBytes);
    bodyBytes = parsed.bodyBytes;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
    let upstream;
    let text;
    try {
      upstream = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${rpcName}`, {
        method: 'POST',
        headers: {
          apikey: config.supabaseAnonKey,
          authorization,
          'content-type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify(parsed.body),
        signal: controller.signal,
        redirect: 'error',
      });
      upstreamStatus = upstream.status;
      text = await upstream.text();
    } catch {
      if (controller.signal.aborted) {
        throw new GatewayError('UPSTREAM_TIMEOUT', 504, 'Aegis database request timed out.');
      }
      throw new GatewayError('UPSTREAM_UNAVAILABLE', 502, 'Aegis database is unavailable.');
    } finally {
      clearTimeout(timer);
    }

    const data = parseUpstreamPayload(text);

    if (!upstream.ok) {
      status = upstream.status;
      errorCode = data?.code || `UPSTREAM_${upstream.status}`;
      writeJson(response, config, origin, requestId, status, {
        error: {
          code: errorCode,
          message: data?.message || 'Aegis database rejected the request.',
          details: data?.details || null,
          hint: data?.hint || null,
        },
        request_id: requestId,
      });
      return;
    }

    if (text && data === null) {
      throw new GatewayError('UPSTREAM_INVALID_RESPONSE', 502, 'Aegis database returned an invalid response.');
    }

    status = 200;
    writeJson(response, config, origin, requestId, status, {
      data,
      error: null,
      request_id: requestId,
    });
  } catch (error) {
    const gatewayError = error instanceof GatewayError
      ? error
      : new GatewayError('AEGIS_GATEWAY_FAILURE', 502, 'Unexpected gateway failure.');
    status = gatewayError.status;
    errorCode = gatewayError.code;
    writeJson(response, config, origin, requestId, status, {
      error: { code: gatewayError.code, message: gatewayError.message },
      request_id: requestId,
    });
  } finally {
    finishLog();
  }
}

export function createAegisServer({
  config = loadAegisConfig(),
  fetchImpl = globalThis.fetch,
  logger = defaultLogger,
} = {}) {
  return createServer((request, response) => handleAegisRequest(request, response, {
    config,
    fetchImpl,
    logger,
  }));
}

export function startAegisServer(options = {}) {
  const config = options.config || loadAegisConfig();
  const logger = options.logger || defaultLogger;
  const server = createAegisServer({ ...options, config, logger });
  server.listen(config.port, '0.0.0.0', () => {
    const address = server.address();
    logRecord(logger, 'info', 'server_started', {
      host: '0.0.0.0',
      port: typeof address === 'object' && address ? address.port : config.port,
      allowed_origin_count: config.allowedOrigins.size,
      allowed_host_count: config.allowedHosts.size,
      max_body_bytes: config.maxBodyBytes,
      upstream_timeout_ms: config.upstreamTimeoutMs,
    });
  });
  return server;
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  startAegisServer();
}
