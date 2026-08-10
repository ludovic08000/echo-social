import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 10 };

const EVENT_RE = /^ios\.[a-z0-9][a-z0-9._-]{0,95}$/;
const TRACE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const DEVICE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ALLOWED_SEVERITIES = new Set(['info', 'warn', 'error']);
const ALLOWED_METADATA_KEYS = new Set([
  'action',
  'stage',
  'outcome',
  'source',
  'reason',
  'durationMs',
  'httpStatus',
  'errorCode',
  'errorName',
  'errorMessage',
  'registered',
  'supported',
  'issue',
  'bindingStatus',
  'routingStatus',
  'lifecycleStatus',
  'approvalStatus',
  'spkCount',
  'opkCount',
  'serverOpkCount',
  'localOpkCount',
  'signingKeyMatches',
  'kxKeyMatches',
  'spkMatches',
  'opksMatch',
  'repairablePrekeys',
  'passkeySupported',
  'passkeyRegistered',
  'online',
  'visibilityState',
]);

class ApiError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify(payload));
}

function parseBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    if (request.body.length > 16_384) throw new ApiError('IOS_DIAGNOSTIC_BODY_TOO_LARGE', 413);
    try { return JSON.parse(request.body); } catch { throw new ApiError('INVALID_JSON'); }
  }
  return {};
}

function bearerToken(request) {
  const header = String(request.headers?.authorization || '');
  if (!header.startsWith('Bearer ')) throw new ApiError('NOT_AUTHENTICATED', 401);
  const token = header.slice(7).trim();
  if (!token || /\s/.test(token)) throw new ApiError('NOT_AUTHENTICATED', 401);
  return token;
}

function envConfig() {
  const supabaseUrl = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(
    process.env.SUPABASE_ANON_KEY
      || process.env.SUPABASE_PUBLISHABLE_KEY
      || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
      || '',
  ).trim();
  const serverKey = String(
    process.env.SUPABASE_SECRET_TOKEN
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '',
  ).trim();
  if (!supabaseUrl || !anonKey || !serverKey) throw new ApiError('IOS_DIAGNOSTIC_SERVER_CONFIG_MISSING', 503);
  return { supabaseUrl, anonKey, serverKey };
}

function clientFor(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function safeText(value, max = 300) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function sanitizeMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (typeof value === 'boolean' || value === null) {
      output[key] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      const text = safeText(value, key === 'errorMessage' ? 500 : 180);
      if (text !== null) output[key] = text;
    }
  }
  return output;
}

function requestUserAgent(request) {
  return safeText(String(request.headers?.['user-agent'] || ''), 500);
}

async function authenticatedUser(token, supabaseUrl, anonKey) {
  const authClient = clientFor(supabaseUrl, anonKey);
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user?.id) throw new ApiError('NOT_AUTHENTICATED', 401);
  return data.user;
}

export default async function handler(request, response) {
  try {
    if (request.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 405);

    const body = parseBody(request);
    const event = safeText(body.event, 100);
    const traceId = safeText(body.traceId, 128);
    const deviceId = body.deviceId == null ? null : safeText(body.deviceId, 128);
    const clientAt = body.clientAt == null ? null : safeText(body.clientAt, 64);
    const severity = ALLOWED_SEVERITIES.has(body.severity) ? body.severity : 'info';

    if (!event || !EVENT_RE.test(event)) throw new ApiError('IOS_DIAGNOSTIC_EVENT_INVALID');
    if (!traceId || !TRACE_RE.test(traceId)) throw new ApiError('IOS_DIAGNOSTIC_TRACE_INVALID');
    if (deviceId && !DEVICE_RE.test(deviceId)) throw new ApiError('IOS_DIAGNOSTIC_DEVICE_INVALID');

    const token = bearerToken(request);
    const { supabaseUrl, anonKey, serverKey } = envConfig();
    const user = await authenticatedUser(token, supabaseUrl, anonKey);
    const admin = clientFor(supabaseUrl, serverKey);
    const metadata = sanitizeMetadata(body.metadata);
    const userAgent = requestUserAgent(request);
    const details = {
      trace_id: traceId,
      device_id: deviceId,
      client_at: clientAt,
      ...metadata,
    };

    const { error: securityError } = await admin.from('security_logs').insert({
      event_type: event,
      user_id: user.id,
      user_agent: userAgent,
      details,
    });
    if (securityError) throw new ApiError('IOS_DIAGNOSTIC_SECURITY_LOG_FAILED', 502, securityError.message);

    if (severity === 'error') {
      const { error: cryptoError } = await admin.from('crypto_error_logs').insert({
        user_id: user.id,
        severity: 'error',
        context: event,
        error_code: safeText(metadata.errorCode, 120) || 'IOS_CLIENT_ERROR',
        error_message: safeText(metadata.errorMessage, 500) || event,
        my_device_id: deviceId,
        stack: null,
        user_agent: userAgent,
        metadata: details,
      });
      if (cryptoError) {
        console.error('[ios-diagnostics] crypto_error_logs insert failed', {
          event,
          code: cryptoError.code ?? null,
          message: safeText(cryptoError.message, 200),
        });
      }
    }

    json(response, 200, { data: { ok: true }, error: null });
  } catch (error) {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError('IOS_DIAGNOSTIC_SERVER_FAILURE', 500, error instanceof Error ? error.message : 'Unexpected diagnostic failure');
    console.error('[ios-diagnostics] request failed', {
      code: apiError.code,
      status: apiError.status,
      message: safeText(apiError.message, 200),
    });
    json(response, apiError.status, {
      data: null,
      error: { code: apiError.code, message: apiError.message },
    });
  }
}
