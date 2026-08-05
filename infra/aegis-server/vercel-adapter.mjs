import { randomUUID } from 'node:crypto';
import { handleAegisRequest, loadAegisConfig } from './server.mjs';

function safeRequestId(value) {
  const candidate = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : randomUUID();
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

function configuredValues(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function vercelRuntimeHosts(env) {
  const hosts = new Set();
  for (const value of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
    const host = normalizeHost(value);
    if (host) hosts.add(host);
  }
  return hosts;
}

function vercelAllowedHosts(env) {
  const hosts = new Set(
    configuredValues(env.AEGIS_ALLOWED_HOSTS || env.AEGIS_ALLOWED_HOST)
      .map(normalizeHost)
      .filter(Boolean),
  );
  for (const host of vercelRuntimeHosts(env)) hosts.add(host);
  return [...hosts].join(',');
}

function vercelAllowedOrigins(env) {
  const origins = new Set(
    configuredValues(env.AEGIS_ALLOWED_ORIGINS || env.AEGIS_ALLOWED_ORIGIN),
  );
  // These values are injected by Vercel for the current deployment only.
  // Adding their exact HTTPS origins enables same-origin Preview RPC calls
  // without accepting arbitrary `*.vercel.app` origins.
  for (const host of vercelRuntimeHosts(env)) origins.add(`https://${host}`);
  return [...origins].join(',');
}

function normalizeVercelEnv(env) {
  return {
    ...env,
    SUPABASE_URL: env.SUPABASE_URL || env.VITE_SUPABASE_URL,
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY
      || env.SUPABASE_PUBLISHABLE_KEY
      || env.VITE_SUPABASE_PUBLISHABLE_KEY,
    AEGIS_ALLOWED_HOSTS: vercelAllowedHosts(env),
    AEGIS_ALLOWED_ORIGINS: vercelAllowedOrigins(env),
  };
}

function writeConfigurationError(request, response, error, logger) {
  const requestId = safeRequestId(request.headers?.['x-request-id']);
  logger({
    timestamp: new Date().toISOString(),
    level: 'error',
    event: 'configuration_failure',
    request_id: requestId,
    code: 'AEGIS_CONFIGURATION_ERROR',
    message: error instanceof Error ? error.message : 'Invalid Aegis configuration.',
  });
  response.writeHead(503, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
  });
  response.end(JSON.stringify({
    error: {
      code: 'AEGIS_CONFIGURATION_ERROR',
      message: 'Aegis gateway is not configured.',
    },
    request_id: requestId,
  }));
}

export function createVercelAegisHandler(path, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = (record) => console.log(JSON.stringify(record)),
} = {}) {
  return async function handler(request, response) {
    let config;
    try {
      config = loadAegisConfig(normalizeVercelEnv(env));
    } catch (error) {
      writeConfigurationError(request, response, error, logger);
      return;
    }

    await handleAegisRequest(request, response, {
      config,
      fetchImpl,
      logger,
      pathOverride: path,
    });
  };
}
