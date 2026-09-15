import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as tokens from '../../../../supabase/functions/_shared/sealedSenderToken';
import * as diagnostics from '../../../../supabase/functions/_shared/aegisDiagnostics.mjs';

const secret = 'SERVER_KEY_SENTINEL_123456789012345678901234567890';
const sender = '01000000-0000-4000-8000-000000000001';
const recipient = '02000000-0000-4000-8000-000000000002';
const conversation = '03000000-0000-4000-8000-000000000003';
let logs: Array<Record<string, any>>;
let rpc = vi.fn();

// Exécute les vrais handlers Edge transpilés ; seuls Deno.serve/env et le réseau SDK sont simulés.
function handler(name: string, client: unknown) {
  let serve: (request: Request) => Promise<Response>;
  const code = ts.transpileModule(readFileSync(resolve(`supabase/functions/${name}/index.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const requireMock = (id: string) => id.includes('supabase-js') ? { createClient: () => client }
    : id.includes('aegisDiagnostics') ? diagnostics : tokens;
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'ANON_SENTINEL',
    SUPABASE_SERVICE_ROLE_KEY: 'ROLE_SENTINEL', SEALED_SENDER_TOKEN_SECRET: secret,
    AEGIS_LOG_LEVEL: 'debug', AEGIS_DEBUG_UNTIL: new Date(Date.now() + 60_000).toISOString(),
  };
  new Function('require', 'exports', 'Deno', code)(requireMock, {}, {
    env: { get: (key: string) => env[key] }, serve: (fn: typeof serve) => { serve = fn; },
  });
  return (request: Request) => serve(request);
}

async function relayBody(overrides: Record<string, unknown> = {}) {
  const payload = { version: 1 as const, sender_user_id: sender, recipient_user_id: recipient,
    conversation_id: conversation, nonce: 'NONCE_SENTINEL_123456789012345678901234567890',
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), context_id: null,
    ...overrides };
  return { token: tokens.encodeSignedToken({ payload, mac: await tokens.signTokenPayload(payload, secret) }),
    conversation_id: conversation, recipient_user_id: recipient, anonymous_sender_tag: 'TAG_SENTINEL',
    sealed_payload: 'CIPHERTEXT_SENTINEL', sealed_header: { opaque: 'HEADER_SENTINEL' } };
}
const request = (body: unknown) => new Request('https://example.test/sealed-relay', { method: 'POST',
  headers: { authorization: 'Bearer AUTH_SENTINEL', 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  logs = []; rpc = vi.fn().mockResolvedValue({ data: 'message-id', error: null });
  vi.spyOn(console, 'log').mockImplementation(line => { logs.push(JSON.parse(line)); });
});
afterEach(() => {
  expect(JSON.stringify(logs)).not.toContain('SENTINEL');
  expect(JSON.stringify(logs)).not.toContain(sender);
  expect(JSON.stringify(logs)).not.toContain(recipient);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['conversation_binding', 'conversation_mismatch', { conversation_id: sender }],
  ['recipient_binding', 'recipient_mismatch', { recipient_user_id: sender }],
  ['token_lifetime', 'token_expired', { issued_at: new Date(Date.now() - 120_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString() }],
])('attributes %s failure without consuming the token', async (step, code, overrides) => {
  const response = await handler('sealed-relay', { rpc })(request(await relayBody(overrides)));
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await response.json()).toEqual({ error: code });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ failed_check: step, error_code: code.toUpperCase() });
  expect(logs[0].checks.token_consume_and_relay).toBe('not_checked');
  expect(rpc).not.toHaveBeenCalled();
});

it('reports malformed tokens before any MAC or database check', async () => {
  const body = await relayBody(); body.token = 'MALFORMED_SECRET_SENTINEL';
  await handler('sealed-relay', { rpc })(request(body));
  expect(logs[0].failed_check).toBe('token_decode');
  expect(logs[0].checks.token_mac).toBe('not_checked');
  expect(rpc).not.toHaveBeenCalled();
});

it('rejects a mismatched MAC and does not call the database', async () => {
  const body = await relayBody();
  const signed = tokens.decodeSignedToken(body.token);
  body.token = tokens.encodeSignedToken({ ...signed, mac: 'AA' });
  await handler('sealed-relay', { rpc })(request(body));
  expect(logs[0]).toMatchObject({ failed_check: 'token_mac', error_code: 'INVALID_TOKEN_MAC' });
  expect(rpc).not.toHaveBeenCalled();
});

it.each(['token_consumed', 'token_context_mismatch', 'token_not_found'])('reports the atomic RPC rejection %s', async code => {
  rpc.mockResolvedValue({ data: null, error: { message: code } });
  await handler('sealed-relay', { rpc })(request(await relayBody()));
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(logs[0]).toMatchObject({ failed_check: 'token_consume_and_relay', error_code: code.toUpperCase() });
  expect(logs[0].checks.token_mac).toBe('pass');
});

it('correlates success without replaying the token or exporting its contents', async () => {
  const response = await handler('sealed-relay', { rpc })(request(await relayBody()));
  expect(response.status).toBe(201);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(logs[0].checks.token_consume_and_relay).toBe('pass');
  expect(response.headers.get('x-aegis-diagnostic-id')).toBe(logs[0].diagnostic_id);
});

it('distinguishes token presence from actual Auth validation during minting', async () => {
  const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'AUTH_SENTINEL' } });
  const response = await handler('sealed-mint-token', { auth: { getUser } })(request({}));
  expect(response.status).toBe(401);
  expect(logs[0]).toMatchObject({ failed_check: 'auth_session', checks: { bearer_syntax: 'pass', token_signing: 'not_checked' } });
});

it.each(['success', 'sender_not_member', 'recipient_not_member', 'token_persistence_failed'])('minting reports %s at the executed check', async scenario => {
  const insert = vi.fn().mockResolvedValue({ error: scenario === 'token_persistence_failed' ? { message: 'DATABASE_SENTINEL' } : null });
  const from = (name: string) => {
    if (name === 'sealed_sender_tokens') return { insert };
    const chain = { select: () => chain, eq: () => chain,
      maybeSingle: async () => ({ data: { id: conversation }, error: null }),
      in: async () => ({ data: [sender, recipient].filter(id => id !== (scenario === 'sender_not_member' ? sender : scenario === 'recipient_not_member' ? recipient : '')).map(user_id => ({ user_id })), error: null }),
    };
    return chain;
  };
  const client = { from, auth: { getUser: async () => ({ data: { user: { id: sender } }, error: null }) } };
  const response = await handler('sealed-mint-token', client)(request({ conversation_id: conversation, recipient_user_id: recipient }));
  expect(logs).toHaveLength(1);
  if (scenario === 'success') {
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.token).toBeTruthy();
    expect(logs[0].checks.token_persistence).toBe('pass');
    expect(JSON.stringify(logs)).not.toContain(data.token);
  } else {
    expect(logs[0].error_code).toBe(scenario.toUpperCase());
    expect(logs[0].failed_check).toBe(scenario === 'token_persistence_failed' ? 'token_persistence' : scenario === 'sender_not_member' ? 'sender_membership' : 'recipient_membership');
  }
  expect(insert).toHaveBeenCalledTimes(scenario.endsWith('not_member') ? 0 : 1);
});
