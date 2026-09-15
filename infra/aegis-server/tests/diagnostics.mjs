import test from 'node:test';
import assert from 'node:assert/strict';
import { createAegisDiagnostic, diagnosticDebugActive } from '../../../supabase/functions/_shared/aegisDiagnostics.mjs';
import { createAegisServer, loadAegisConfig } from '../server.mjs';

test('checks distinguish failed, passed and not checked; only one bounded log is emitted', () => {
  const logs = [];
  const d = createAegisDiagnostic('sealed-relay', { logger: r => logs.push(r) });
  d.step('token_decode'); d.step('recipient_binding');
  d.finish(403, 'recipient_mismatch'); d.finish(201);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].checks.token_decode, 'pass');
  assert.equal(logs[0].checks.recipient_binding, 'fail');
  assert.equal(logs[0].checks.token_mac, 'not_checked');
  assert.equal(logs[0].failed_check, 'recipient_binding');
  assert.equal(logs[0].error_code, 'RECIPIENT_MISMATCH');
  assert.equal(logs[0].debug, false);
  assert.ok(JSON.stringify(logs).length < 2000);
});

test('debug requires an explicit short deadline and expires during a request', () => {
  let now = Date.now();
  const until = new Date(now + 60_000).toISOString();
  assert.equal(diagnosticDebugActive('debug', until, now), true);
  assert.equal(diagnosticDebugActive('info', until, now), false);
  assert.equal(diagnosticDebugActive('debug', '', now), false);
  assert.equal(diagnosticDebugActive('debug', new Date(now + 900_001).toISOString(), now), false);
  const d = createAegisDiagnostic('gateway', { now: () => now, logLevel: 'debug', debugUntil: until, logger: () => {} });
  d.step('database_rpc'); now += 60_001;
  const r = d.finish(200);
  assert.equal(r.debug, false);
  assert.equal(r.check_duration_ms, undefined);
});

test('debug adds timings without retaining free-form inputs, errors or unknown fields', () => {
  const secret = 'PRIVATE_KEY_SENTINEL';
  const d = createAegisDiagnostic('gateway', { logLevel: 'debug', debugUntil: new Date(Date.now() + 60_000).toISOString(),
    token: secret, logger: () => {} });
  d.step(secret); d.step('database_rpc');
  const r = d.finish(403, secret);
  assert.equal(r.error_code, 'UNCLASSIFIED_ERROR');
  assert.equal(r.debug, true);
  assert.ok(r.check_duration_ms);
  assert.equal(JSON.stringify(r).includes(secret), false);
});

test('gateway correlates a database rejection, never calls bearer presence authentication', async () => {
  const logs = [];
  const config = loadAegisConfig({ SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'ANON_SENTINEL',
    AEGIS_LOG_LEVEL: 'debug', AEGIS_DEBUG_UNTIL: new Date(Date.now() + 60_000).toISOString() });
  const server = createAegisServer({ config, logger: r => logs.push(r),
    fetchImpl: async () => new Response(JSON.stringify({ code: 'PGRST301', message: 'JWT_SECRET_SENTINEL' }), { status: 401 }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/rpc/aegis_send_message`, {
      method: 'POST', headers: { authorization: 'Bearer AUTH_SECRET_SENTINEL', 'content-type': 'application/json', 'x-request-id': 'CALLER_SECRET_SENTINEL' },
      body: JSON.stringify({ ciphertext: 'MESSAGE_SECRET_SENTINEL', key: 'KEY_SECRET_SENTINEL' }),
    });
    assert.equal(response.status, 401);
    const diagnostic = logs.find(r => r.event === 'aegis_checks');
    assert.equal(response.headers.get('x-aegis-diagnostic-id'), diagnostic.diagnostic_id);
    assert.equal(diagnostic.failed_check, 'database_rpc');
    assert.equal(diagnostic.checks.bearer_syntax, 'pass');
    assert.equal(diagnostic.checks.database_response, 'not_checked');
    assert.equal(diagnostic.error_code, 'PGRST301');
    assert.equal(JSON.stringify(logs).includes('SENTINEL'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
