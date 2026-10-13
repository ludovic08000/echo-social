import test from 'node:test';
import assert from 'node:assert/strict';
import { createAegisJourney, approvalEmailSession } from '../../../supabase/functions/_shared/aegisJourney.mjs';
import { createAegisServer, loadAegisConfig } from '../server.mjs';

const session = '98c32ea4-faae-4c87-b8d4-8a0ea9e7be7e';
test('journey is UTC, ordered, correlated and excludes arbitrary inputs', () => {
  const logs = []; let now = Date.UTC(2026, 9, 13);
  const journey = createAegisJourney({ logger: r => logs.push(r), now: () => now });
  journey('approval_email_requested', 'start', session); now += 25;
  journey('approval_email_queued', 'success', session);
  journey('SECRET', 'success', session);
  journey('login_decision', 'success', 'SECRET');
  assert.equal(logs.length, 3);
  assert.equal(logs[0].timestamp, '2026-10-13T00:00:00.000Z');
  assert.equal(logs[1].elapsed_ms, 25);
  assert.equal(logs[1].sequence, 2);
  assert.equal(logs[0].request_id, logs[1].request_id);
  assert.equal(logs[2].session_id, null);
  assert.equal(JSON.stringify(logs).includes('SECRET'), false);
});
test('provider correlation discards token hash and rejects arbitrary IDs', () => {
  assert.equal(approvalEmailSession(`login-security:${session}:1234567890abcdef`), session);
  assert.equal(approvalEmailSession(`login-security:${session}:1234567890abcdef:SECRET`), null);
  assert.equal(approvalEmailSession(null), null);
});
test('logging failure cannot fail approval', () => {
  assert.doesNotThrow(() => createAegisJourney({ logger: () => { throw Error('offline'); } })('login_decision', 'success', session));
});
test('gateway persists a safe diagnostic after the response without breaking the send', async () => {
  const logs = []; const calls = [];
  const config = loadAegisConfig({SUPABASE_URL:'https://example.test',SUPABASE_ANON_KEY:'anon',AEGIS_JOURNEY_ENABLED:'true'});
  const server = createAegisServer({config,logger:r => logs.push(r),fetchImpl:async (url, options) => {
    calls.push({url,body:JSON.parse(options.body)});
    if(url.endsWith('record_aegis_request_event')) throw Error('LOG_FAILED_SECRET');
    return new Response(JSON.stringify({code:'42501',message:'DEVICE_NOT_FOUND'}),{status:403});
  }});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/rpc/aegis_send_message`,{
      method:'POST',headers:{authorization:'Bearer SECRET', 'content-type':'application/json'},body:JSON.stringify({ciphertext:'SECRET_CONTENT'})});
    assert.equal(res.status,403);
    const report = calls.find(c => c.url.endsWith('record_aegis_request_event')).body;
    assert.equal(report.p_error_code,'DEVICE_NOT_FOUND');
    assert.equal(report.p_request_id,res.headers.get('x-aegis-diagnostic-id'));
    assert.equal(JSON.stringify(report).includes('SECRET'),false);
    assert.equal(JSON.stringify(logs).includes('SECRET'),false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
