import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAegisServer } from '../server.mjs';

const baseConfig = {
  port: 0,
  supabaseUrl: 'https://supabase.test',
  supabaseAnonKey: 'public-anon-key',
  allowedOrigins: new Set(['https://allowed.test']),
  maxBodyBytes: 1_024,
  upstreamTimeoutMs: 250,
};

async function withGateway(fetchImpl, callback, config = baseConfig) {
  const logs = [];
  const server = createAegisServer({ config, fetchImpl, logger: (record) => logs.push(record) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await callback({ baseUrl, logs });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('health accepts query parameters and returns a correlated request id', async () => {
  await withGateway(async () => new Response('{}'), async ({ baseUrl, logs }) => {
    const response = await fetch(`${baseUrl}/health?probe=1`, {
      headers: { 'x-request-id': 'health-probe-1' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'health-probe-1');
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.request_id, 'health-probe-1');
    assert.equal(logs.at(-1).status, 200);
  });
});

test('RPC requires a bearer token', async () => {
  await withGateway(async () => new Response('{}'), async ({ baseUrl, logs }) => {
    const response = await fetch(`${baseUrl}/v1/rpc/aegis_sync_device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://allowed.test' },
      body: '{}',
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'NOT_AUTHENTICATED');
    assert.equal(logs.at(-1).error_code, 'NOT_AUTHENTICATED');
  });
});

test('RPC rejects a denied browser origin', async () => {
  await withGateway(async () => new Response('{}'), async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/rpc/aegis_sync_device`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        origin: 'https://denied.test',
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'ORIGIN_DENIED');
  });
});

test('invalid JSON is a client error, not a gateway error', async () => {
  await withGateway(async () => new Response('{}'), async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/rpc/aegis_sync_device`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        origin: 'https://allowed.test',
      },
      body: '{',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_JSON');
  });
});

test('body-size limit is enforced before forwarding', async () => {
  let forwarded = false;
  const config = { ...baseConfig, maxBodyBytes: 16 };
  await withGateway(async () => {
    forwarded = true;
    return new Response('{}');
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/rpc/aegis_sync_device`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        origin: 'https://allowed.test',
      },
      body: JSON.stringify({ value: 'x'.repeat(64) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'BODY_TOO_LARGE');
    assert.equal(forwarded, false);
  }, config);
});

test('RPC forwards the caller token and payload without logging secrets', async () => {
  let upstreamCall;
  await withGateway(async (url, options) => {
    upstreamCall = { url, options };
    return new Response(JSON.stringify([{ copy_id: 'copy-secret', encrypted_body: 'cipher-secret' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, async ({ baseUrl, logs }) => {
    const response = await fetch(`${baseUrl}/v1/rpc/aegis_sync_device?ignored=1`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer jwt-secret',
        'content-type': 'application/json',
        origin: 'https://allowed.test',
        'x-request-id': 'sync-probe-1',
      },
      body: JSON.stringify({ p_device_id: 'device-secret', p_limit: 5 }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamCall.url, 'https://supabase.test/rest/v1/rpc/aegis_sync_device');
    assert.equal(upstreamCall.options.headers.authorization, 'Bearer jwt-secret');
    assert.deepEqual(JSON.parse(upstreamCall.options.body), { p_device_id: 'device-secret', p_limit: 5 });
    const serializedLogs = JSON.stringify(logs);
    assert.equal(serializedLogs.includes('jwt-secret'), false);
    assert.equal(serializedLogs.includes('device-secret'), false);
    assert.equal(serializedLogs.includes('cipher-secret'), false);
    assert.equal(logs.at(-1).rpc, 'aegis_sync_device');
    assert.equal(logs.at(-1).upstream_status, 200);
  });
});

test('upstream PostgreSQL errors preserve the safe error contract', async () => {
  await withGateway(async () => new Response(JSON.stringify({
    code: 'E2EE_DEVICE_NOT_AUTHORIZED',
    message: 'Device is not authorized.',
  }), { status: 403 }), async ({ baseUrl, logs }) => {
    const response = await fetch(`${baseUrl}/v1/rpc/aegis_sync_device`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        origin: 'https://allowed.test',
      },
      body: JSON.stringify({ p_device_id: 'invalid-device', p_limit: 1 }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'E2EE_DEVICE_NOT_AUTHORIZED');
    assert.equal(logs.at(-1).upstream_status, 403);
  });
});

test('upstream timeout maps to HTTP 504', async () => {
  const config = { ...baseConfig, upstreamTimeoutMs: 25 };
  await withGateway((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), async ({ baseUrl, logs }) => {
    const response = await fetch(`${baseUrl}/v1/rpc/aegis_sync_device`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        origin: 'https://allowed.test',
      },
      body: JSON.stringify({ p_device_id: 'device-id', p_limit: 1 }),
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'UPSTREAM_TIMEOUT');
    assert.equal(logs.at(-1).error_code, 'UPSTREAM_TIMEOUT');
  }, config);
});
