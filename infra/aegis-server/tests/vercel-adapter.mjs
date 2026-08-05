import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelAegisHandler } from '../vercel-adapter.mjs';

function responseRecorder() {
  return {
    status: null,
    headers: {},
    text: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = { ...headers };
    },
    end(value = '') {
      this.text = String(value);
    },
  };
}

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_ANON_KEY: 'public-anon-key',
  AEGIS_ALLOWED_ORIGINS: 'https://forsure.fans',
  AEGIS_ALLOWED_HOSTS: 'aegis.forsure.fans',
};

test('Vercel health handler serves the Aegis contract on the allowed host', async () => {
  const handler = createVercelAegisHandler('/health', { env, logger: () => {} });
  const response = responseRecorder();
  await handler({
    method: 'GET',
    url: '/api/aegis-health',
    headers: { host: 'aegis.forsure.fans' },
  }, response);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).service, 'aegis-server');
});

test('Vercel adapter accepts the existing public Vite Supabase variables', async () => {
  const handler = createVercelAegisHandler('/health', {
    env: {
      VITE_SUPABASE_URL: 'https://supabase.test',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'public-publishable-key',
    },
    logger: () => {},
  });
  const response = responseRecorder();
  await handler({ method: 'GET', headers: { host: 'preview.vercel.app' } }, response);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).ok, true);
});

test('Vercel-provided preview host and exact origin are added without wildcard trust', async () => {
  let forwardedBody;
  const previewHost = 'echo-social-preview.vercel.app';
  const handler = createVercelAegisHandler('/v1/rpc/aegis_sync_device', {
    env: {
      ...env,
      VERCEL_URL: previewHost,
      VERCEL_BRANCH_URL: 'echo-social-git-feature.vercel.app',
    },
    logger: () => {},
    fetchImpl: async (_url, options) => {
      forwardedBody = JSON.parse(options.body);
      return new Response('[]', { status: 200 });
    },
  });

  const previewResponse = responseRecorder();
  await handler({
    method: 'POST',
    headers: {
      host: previewHost,
      origin: `https://${previewHost}`,
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: { p_device_id: 'device-stable', p_limit: 25 },
  }, previewResponse);
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers['access-control-allow-origin'], `https://${previewHost}`);
  assert.deepEqual(forwardedBody, { p_device_id: 'device-stable', p_limit: 25 });

  const deniedHostResponse = responseRecorder();
  await handler({
    method: 'GET',
    headers: { host: 'attacker.vercel.app' },
  }, deniedHostResponse);
  assert.equal(deniedHostResponse.status, 404);

  const deniedOriginResponse = responseRecorder();
  await handler({
    method: 'POST',
    headers: {
      host: previewHost,
      origin: 'https://attacker.vercel.app',
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: { p_device_id: 'device-stable', p_limit: 25 },
  }, deniedOriginResponse);
  assert.equal(deniedOriginResponse.status, 403);
  assert.equal(JSON.parse(deniedOriginResponse.text).error.code, 'ORIGIN_DENIED');
});

test('Vercel adapter forwards an already parsed JSON body', async () => {
  let forwardedBody;
  const handler = createVercelAegisHandler('/v1/rpc/aegis_sync_device', {
    env,
    logger: () => {},
    fetchImpl: async (_url, options) => {
      forwardedBody = JSON.parse(options.body);
      return new Response('[]', { status: 200 });
    },
  });
  const response = responseRecorder();
  await handler({
    method: 'POST',
    url: '/api/aegis-sync-device',
    headers: {
      host: 'aegis.forsure.fans',
      origin: 'https://forsure.fans',
      authorization: 'Bearer test-token',
    },
    body: { p_device_id: 'device-stable', p_limit: 25 },
  }, response);
  assert.equal(response.status, 200);
  assert.deepEqual(forwardedBody, { p_device_id: 'device-stable', p_limit: 25 });
});

test('Vercel adapter fails closed when required environment variables are absent', async () => {
  const logs = [];
  const handler = createVercelAegisHandler('/health', {
    env: {},
    logger: (record) => logs.push(record),
  });
  const response = responseRecorder();
  await handler({ method: 'GET', headers: {} }, response);
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.text).error.code, 'AEGIS_CONFIGURATION_ERROR');
  assert.equal(logs.at(-1).event, 'configuration_failure');
});
