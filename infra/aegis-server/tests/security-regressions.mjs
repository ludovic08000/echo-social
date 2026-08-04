import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAegisServer } from '../server.mjs';
import { runSmokeClient } from '../smoke-client.mjs';

const config = {
  port: 0,
  supabaseUrl: 'https://supabase.test',
  supabaseAnonKey: 'public-anon-key',
  allowedOrigins: new Set(),
  maxBodyBytes: 1_024,
  upstreamTimeoutMs: 250,
};

test('successful non-JSON upstream response is rejected safely', async () => {
  const logs = [];
  const server = createAegisServer({
    config,
    logger: (record) => logs.push(record),
    fetchImpl: async () => new Response('<html>unexpected</html>', { status: 200 }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/rpc/aegis_sync_device`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_device_id: 'device-id', p_limit: 1 }),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'UPSTREAM_INVALID_RESPONSE');
    assert.equal(logs.at(-1).error_code, 'UPSTREAM_INVALID_RESPONSE');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('smoke client refuses access tokens in process arguments', async () => {
  await assert.rejects(
    runSmokeClient(['health', '--access-token', 'jwt-secret'], {
      env: {},
      fetchImpl: async () => new Response('{}', { status: 200 }),
      sink: () => {},
    }),
    /Pass AEGIS_ACCESS_TOKEN through the environment/,
  );
});
