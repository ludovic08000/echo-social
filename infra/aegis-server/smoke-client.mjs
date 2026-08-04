import { randomUUID } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const RPC_PATHS = {
  send: '/v1/rpc/aegis_send_message',
  sync: '/v1/rpc/aegis_sync_device',
  ack: '/v1/rpc/aegis_ack_device_messages',
};

function parseInteger(value, fallback, minimum = 1, maximum = 250) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), minimum), maximum);
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'scenario';
  const values = new Map();
  const flags = new Set();
  let index = command === argv[0] ? 1 : 0;

  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.add(key);
      index += 1;
      continue;
    }
    const existing = values.get(key);
    values.set(key, existing == null ? next : Array.isArray(existing) ? [...existing, next] : [existing, next]);
    index += 2;
  }

  return { command, values, flags };
}

function one(values, key, fallback = undefined) {
  const value = values.get(key);
  return Array.isArray(value) ? value.at(-1) : value ?? fallback;
}

function many(values, key) {
  const value = values.get(key);
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function emit(event, fields = {}, sink = console.log) {
  sink(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  }));
}

function summarizeData(data) {
  if (Array.isArray(data)) {
    const first = data[0];
    return {
      type: 'array',
      count: data.length,
      fields: first && typeof first === 'object' ? Object.keys(first).sort() : [],
    };
  }
  if (data && typeof data === 'object') {
    return { type: 'object', fields: Object.keys(data).sort() };
  }
  return { type: data === null ? 'null' : typeof data };
}

async function parseJsonFile(path) {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON file: ${path}`);
  }
}

async function captureResponse(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Some platforms do not support POSIX modes. The file still contains no JWT.
  }
}

export async function requestJson({
  baseUrl,
  path,
  method = 'POST',
  accessToken,
  origin,
  payload,
  timeoutMs = 20_000,
  fetchImpl = globalThis.fetch,
  sink = console.log,
  expectedStatus,
}) {
  const requestId = randomUUID();
  const url = new URL(path, `${baseUrl.replace(/\/+$/, '')}/`).toString();
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-request-id': requestId,
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (origin) headers.origin = origin;

  const startedAt = performance.now();
  emit('probe_started', {
    request_id: requestId,
    method,
    path: new URL(url).pathname,
    has_token: Boolean(accessToken),
    has_origin: Boolean(origin),
  }, sink);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
  } catch (error) {
    const code = controller.signal.aborted ? 'CLIENT_TIMEOUT' : 'CLIENT_NETWORK_ERROR';
    emit('probe_failed', {
      request_id: requestId,
      code,
      duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      message: error instanceof Error ? error.message : String(error),
    }, sink);
    throw Object.assign(new Error(code), { code });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { non_json_response: true, byte_length: Buffer.byteLength(text) };
    }
  }

  const statusMatches = expectedStatus == null
    ? response.ok
    : Array.isArray(expectedStatus)
      ? expectedStatus.includes(response.status)
      : response.status === expectedStatus;

  const summary = body?.error
    ? {
        error_code: body.error.code || 'UNKNOWN_ERROR',
        error_message: body.error.message || 'Unknown error',
      }
    : summarizeData(body?.data ?? body);

  emit(statusMatches ? 'probe_succeeded' : 'probe_failed', {
    request_id: response.headers.get('x-request-id') || requestId,
    status: response.status,
    duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    ...summary,
  }, sink);

  if (!statusMatches) {
    const error = new Error(body?.error?.message || `Unexpected HTTP status ${response.status}`);
    error.code = body?.error?.code || `HTTP_${response.status}`;
    error.status = response.status;
    error.response = body;
    throw error;
  }

  return {
    status: response.status,
    requestId: response.headers.get('x-request-id') || requestId,
    body,
  };
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function buildOptions(argv, env) {
  const parsed = parseArgs(argv);
  const values = parsed.values;
  const flags = parsed.flags;
  const envMessageIds = String(env.AEGIS_ACK_MESSAGE_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    command: parsed.command,
    baseUrl: one(values, 'base-url', env.AEGIS_BASE_URL || 'http://127.0.0.1:8787'),
    accessToken: one(values, 'access-token', env.AEGIS_ACCESS_TOKEN || ''),
    deviceId: one(values, 'device-id', env.AEGIS_DEVICE_ID || ''),
    origin: one(values, 'origin', env.AEGIS_TEST_ORIGIN || ''),
    payloadFile: one(values, 'payload-file', env.AEGIS_TEST_PAYLOAD_FILE || ''),
    captureFile: one(values, 'capture-file', env.AEGIS_CAPTURE_FILE || ''),
    timeoutMs: parseInteger(one(values, 'timeout-ms', env.AEGIS_TEST_TIMEOUT_MS), 20_000, 100, 120_000),
    limit: parseInteger(one(values, 'limit', env.AEGIS_SYNC_LIMIT), 25, 1, 250),
    markRead: flags.has('mark-read') || parseBoolean(env.AEGIS_MARK_READ),
    messageIds: [...many(values, 'message-id'), ...envMessageIds],
    skipUnauthenticated: flags.has('skip-unauthenticated'),
  };
}

async function runHealth(options, dependencies) {
  return requestJson({
    baseUrl: options.baseUrl,
    path: '/health?source=smoke-client',
    method: 'GET',
    timeoutMs: options.timeoutMs,
    fetchImpl: dependencies.fetchImpl,
    sink: dependencies.sink,
  });
}

async function runSync(options, dependencies) {
  return requestJson({
    baseUrl: options.baseUrl,
    path: RPC_PATHS.sync,
    accessToken: required(options.accessToken, 'AEGIS_ACCESS_TOKEN'),
    origin: options.origin,
    payload: {
      p_device_id: required(options.deviceId, 'AEGIS_DEVICE_ID'),
      p_limit: options.limit,
    },
    timeoutMs: options.timeoutMs,
    fetchImpl: dependencies.fetchImpl,
    sink: dependencies.sink,
  });
}

async function runAck(options, dependencies) {
  if (options.messageIds.length === 0) {
    throw new Error('At least one --message-id or AEGIS_ACK_MESSAGE_IDS value is required');
  }
  return requestJson({
    baseUrl: options.baseUrl,
    path: RPC_PATHS.ack,
    accessToken: required(options.accessToken, 'AEGIS_ACCESS_TOKEN'),
    origin: options.origin,
    payload: {
      p_device_id: required(options.deviceId, 'AEGIS_DEVICE_ID'),
      p_message_ids: options.messageIds,
      p_mark_read: options.markRead,
    },
    timeoutMs: options.timeoutMs,
    fetchImpl: dependencies.fetchImpl,
    sink: dependencies.sink,
  });
}

async function runSend(options, dependencies) {
  const payloadFile = required(options.payloadFile, '--payload-file or AEGIS_TEST_PAYLOAD_FILE');
  const payload = await parseJsonFile(payloadFile);
  return requestJson({
    baseUrl: options.baseUrl,
    path: RPC_PATHS.send,
    accessToken: required(options.accessToken, 'AEGIS_ACCESS_TOKEN'),
    origin: options.origin,
    payload,
    timeoutMs: options.timeoutMs,
    fetchImpl: dependencies.fetchImpl,
    sink: dependencies.sink,
  });
}

async function runScenario(options, dependencies) {
  const results = { health: await runHealth(options, dependencies) };

  if (!options.skipUnauthenticated) {
    results.unauthenticated = await requestJson({
      baseUrl: options.baseUrl,
      path: RPC_PATHS.sync,
      origin: options.origin,
      payload: { p_device_id: 'smoke-client-invalid-device', p_limit: 1 },
      timeoutMs: options.timeoutMs,
      fetchImpl: dependencies.fetchImpl,
      sink: dependencies.sink,
      expectedStatus: 401,
    });
  }

  if (options.accessToken && options.deviceId) {
    results.sync = await runSync(options, dependencies);
  } else {
    emit('authenticated_probes_skipped', {
      reason: 'AEGIS_ACCESS_TOKEN and AEGIS_DEVICE_ID are not both configured',
    }, dependencies.sink);
  }

  if (options.messageIds.length > 0) {
    results.ack = await runAck(options, dependencies);
  }

  if (options.payloadFile) {
    results.send = await runSend(options, dependencies);
  }

  return results;
}

export async function runSmokeClient(argv = process.argv.slice(2), {
  env = process.env,
  fetchImpl = globalThis.fetch,
  sink = console.log,
} = {}) {
  const options = buildOptions(argv, env);
  const dependencies = { fetchImpl, sink };
  let result;

  switch (options.command) {
    case 'health':
      result = await runHealth(options, dependencies);
      break;
    case 'sync':
      result = await runSync(options, dependencies);
      break;
    case 'ack':
      result = await runAck(options, dependencies);
      break;
    case 'send':
      result = await runSend(options, dependencies);
      break;
    case 'scenario':
      result = await runScenario(options, dependencies);
      break;
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }

  if (options.captureFile) {
    await captureResponse(options.captureFile, result);
    emit('response_captured', { path: options.captureFile, mode: '0600' }, sink);
  }
  return result;
}

function printUsage() {
  process.stderr.write(`Aegis smoke client\n\n`);
  process.stderr.write(`Commands: scenario, health, sync, ack, send\n\n`);
  process.stderr.write(`Examples:\n`);
  process.stderr.write(`  node infra/aegis-server/smoke-client.mjs health --base-url http://127.0.0.1:8787\n`);
  process.stderr.write(`  AEGIS_ACCESS_TOKEN=... AEGIS_DEVICE_ID=... npm run aegis:smoke\n`);
  process.stderr.write(`  node infra/aegis-server/smoke-client.mjs ack --message-id <uuid> --mark-read\n`);
  process.stderr.write(`  node infra/aegis-server/smoke-client.mjs send --payload-file ./send-payload.json\n`);
  process.stderr.write(`\nLogs never print JWTs, ciphertext or identifier values. Use --capture-file for a local 0600 raw response.\n`);
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runSmokeClient().catch((error) => {
    emit('smoke_client_failed', {
      code: error?.code || 'CLIENT_CONFIGURATION_ERROR',
      status: error?.status || null,
      message: error instanceof Error ? error.message : String(error),
    }, console.error);
    printUsage();
    process.exitCode = 1;
  });
}

export { summarizeData };
