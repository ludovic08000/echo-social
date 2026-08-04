import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, runSmokeClient, summarizeData } from '../smoke-client.mjs';

test('response summaries expose shape, not values', () => {
  assert.deepEqual(summarizeData([{ message_id: 'secret', encrypted_body: 'cipher' }]), {
    type: 'array',
    count: 1,
    fields: ['encrypted_body', 'message_id'],
  });
});

test('request logs never contain the access token or payload values', async () => {
  const lines = [];
  const result = await requestJson({
    baseUrl: 'https://aegis.test',
    path: '/v1/rpc/aegis_sync_device',
    accessToken: 'jwt-secret',
    origin: 'https://allowed.test',
    payload: { p_device_id: 'device-secret', p_limit: 5 },
    sink: (line) => lines.push(line),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer jwt-secret');
      return new Response(JSON.stringify({
        data: [{ message_id: 'message-secret', encrypted_body: 'cipher-secret' }],
        error: null,
      }), {
        status: 200,
        headers: { 'x-request-id': 'server-request-id' },
      });
    },
  });

  assert.equal(result.status, 200);
  const logs = lines.join('\n');
  for (const secret of ['jwt-secret', 'device-secret', 'message-secret', 'cipher-secret']) {
    assert.equal(logs.includes(secret), false);
  }
  assert.equal(logs.includes('"count":1'), true);
});

test('default scenario checks health and unauthenticated rejection without credentials', async () => {
  const lines = [];
  const calls = [];
  await runSmokeClient(['scenario', '--base-url', 'https://aegis.test'], {
    env: {},
    sink: (line) => lines.push(line),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (new URL(url).pathname === '/health') {
        return new Response(JSON.stringify({ ok: true, service: 'aegis-server' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { code: 'NOT_AUTHENTICATED', message: 'Bearer token required.' },
      }), { status: 401 });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(lines.some((line) => line.includes('authenticated_probes_skipped')), true);
});
