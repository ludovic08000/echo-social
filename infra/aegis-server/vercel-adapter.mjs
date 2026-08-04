import { randomUUID } from 'node:crypto';
import { handleAegisRequest, loadAegisConfig } from './server.mjs';

function safeRequestId(value) {
  const candidate = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : randomUUID();
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
      config = loadAegisConfig(env);
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
