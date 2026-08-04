import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAegisServer, loadAegisConfig } from '../server.mjs';

const baseConfig = {
  port: 0,
  supabaseUrl: 'https://supabase.test',
  supabaseAnonKey: 'public-anon-key',
  allowedOrigins: new Set(['https://allowed.test']),
  allowedHosts: new Set(),
  maxBodyBytes: 1_024,
  upstreamTimeoutMs: 100,
};

async function withGateway(fetchImpl, callback, config = baseConfig, logger = () => {}) {
  const server = createAegisServer({ config, fetchImpl, logger });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function rpcRequest(baseUrl, headers = {}, body = '{}') {
  return fetch(`${baseUrl}/v1/rpc/aegis_sync_device`, {
    method: 'POST',
    headers: {
      origin: 'https://allowed.test',
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
}

test('rejects an empty bearer token before forwarding', async () => {
  let forwarded = false;
  await withGateway(async () => {
    forwarded = true;
    return new Response('{}');
  }, async (baseUrl) => {
    const response = await rpcRequest(baseUrl, { authorization: 'Bearer ' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'NOT_AUTHENTICATED');
    assert.equal(forwarded, false);
  });
});

test('empty origin allowlist denies browser origins but permits non-browser requests', async () => {
  const config = { ...baseConfig, allowedOrigins: new Set() };
  await withGateway(async () => new Response('[]', { status: 200 }), async (baseUrl) => {
    const browserResponse = await rpcRequest(baseUrl, { authorization: 'Bearer token' });
    assert.equal(browserResponse.status, 403);
    assert.equal((await browserResponse.json()).error.code, 'ORIGIN_DENIED');

    const nativeResponse = await fetch(`${baseUrl}/v1/rpc/aegis_sync_device`, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(nativeResponse.status, 200);
  }, config);
});

test('Host header takes precedence over spoofable x-forwarded-host', async () => {
  const config = { ...baseConfig, allowedHosts: new Set(['aegis.forsure.fans']) };
  await withGateway(async () => new Response('{}'), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: {
        host: 'evil.test',
        'x-forwarded-host': 'aegis.forsure.fans',
      },
    });
    assert.equal(response.status, 404);
  }, config);
});

test('upstream timeout covers response-body consumption, not only headers', async () => {
  const config = { ...baseConfig, upstreamTimeoutMs: 25 };
  await withGateway(async (_url, options) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }), async (baseUrl) => {
    const response = await rpcRequest(baseUrl, { authorization: 'Bearer token' });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'UPSTREAM_TIMEOUT');
  }, config);
});

test('unknown OPTIONS route is not accepted as a valid preflight', async () => {
  await withGateway(async () => new Response('{}'), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/not-an-aegis-route`, {
      method: 'OPTIONS',
      headers: { origin: 'https://allowed.test' },
    });
    assert.equal(response.status, 404);
  });
});

test('upstream redirects are disabled when forwarding a JWT', async () => {
  let redirectMode;
  await withGateway(async (_url, options) => {
    redirectMode = options.redirect;
    return new Response('[]', { status: 200 });
  }, async (baseUrl) => {
    const response = await rpcRequest(baseUrl, { authorization: 'Bearer token' });
    assert.equal(response.status, 200);
    assert.equal(redirectMode, 'error');
  });
});

test('configuration rejects non-HTTP Supabase URLs and embedded credentials', () => {
  assert.throws(() => loadAegisConfig({
    SUPABASE_URL: 'file:///tmp/database',
    SUPABASE_ANON_KEY: 'key',
  }), /HTTP\(S\)/);
  assert.throws(() => loadAegisConfig({
    SUPABASE_URL: 'https://user:password@supabase.test',
    SUPABASE_ANON_KEY: 'key',
  }), /embedded credentials/);
});

test('logger failures never change an otherwise successful response', async () => {
  await withGateway(async () => new Response('{}'), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }, baseConfig, () => { throw new Error('logger down'); });
});
