// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const code = ts.transpileModule(readFileSync('supabase/functions/livekit-token/index.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const userId = '11111111-1111-4111-8111-111111111111';
const callId = '22222222-2222-4222-8222-222222222222';
const convId = '33333333-3333-4333-8333-333333333333';
const approval = vi.fn();
const mint = vi.fn();
const grant = vi.fn();
const from = vi.fn();
const deviceFilters: unknown[][] = [];
const rows = new Map<string, unknown>();
let handler: (req: Request) => Promise<Response>;
beforeEach(() => {
  vi.resetAllMocks();
  deviceFilters.length = 0;
  rows.clear();
  rows.set('active_calls', { id: callId, conversation_id: convId, caller_id: userId,
    caller_device_id: 'test-device', protocol_version: 5, status: 'ringing', room_name: `call-${callId}` });
  rows.set('conversation_participants', { user_id: userId });
  rows.set('user_devices', { device_id: 'test-device', is_active: true, revoked_at: null, stale_at: null,
    crypto_invalid_at: null, account_bound_at: '2026-10-12', approval_status: 'approved', binding_status: 'bound',
    routing_status: 'ready', lifecycle_status: 'ready', user_id: userId });
  rows.set('live_streams', { user_id: 'host', is_active: true, started_at: new Date().toISOString() });
  approval.mockResolvedValue({ data: true, error: null });
  mint.mockResolvedValue('test-livekit-jwt');
  from.mockImplementation((table: string) => {
    const filters: unknown[][] = [];
    const chain = {
      select: vi.fn(() => chain),
      eq: (field: string, value: unknown) => { filters.push(['eq', field, value]); return chain; },
      is: (field: string, value: unknown) => { filters.push(['is', field, value]); return chain; },
      not: (field: string, op: string, value: unknown) => { filters.push(['not', field, op, value]); return chain; },
      in: vi.fn(() => chain),
      insert: vi.fn(async () => ({ error: null })),
      maybeSingle: async () => {
        if (table === 'user_devices') {
          deviceFilters.push(...filters);
          const row = rows.get(table) as Record<string, unknown> | undefined;
          const valid = row && filters.every(([op, field, value, other]) => op === 'not'
            ? row[String(field)] !== other : row[String(field)] === value);
          return { data: valid ? row : null, error: null };
        }
        return { data: rows.get(table) ?? null, error: null };
      },
    };
    return chain;
  });
  runInNewContext(code, {
    exports: {}, Request, Response, Headers, URL, Date,
    Deno: {
      serve: (fn: typeof handler) => { handler = fn; },
      env: { get: (name: string) => name === 'LIVEKIT_URL' ? 'wss://test.invalid' : 'test-setting' },
    },
    require: (name: string) => {
      if (name === 'https://esm.sh/@supabase/supabase-js@2') return { createClient: () => ({
        auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, rpc: approval, from,
      }) };
      if (name === 'npm:livekit-server-sdk@2') return { AccessToken: class { addGrant = grant; toJwt = mint; } };
      if (name === '../_shared/cors.ts') return { getCorsHeaders: () => ({}) };
      if (name === '../_shared/rate-limit.ts') return { checkRateLimit: async () => null };
      if (name === '../_shared/aegisDiagnostics.mjs') return { createAegisDiagnostic: () => ({ id: 'test-id', step: vi.fn(), finish: vi.fn() }) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
});
const request = (prefix = 'call') => new Request('https://test.invalid/token', {
  method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
  body: JSON.stringify({ roomName: `${prefix}-${callId}`, deviceId: 'test-device' }),
});

describe('actual private-call token handler with mocked external services', () => {
  it('allows an approved conversation member on a healthy invited device', async () => {
    expect((await handler(request())).status).toBe(200);
    expect(mint).toHaveBeenCalledOnce();
    expect(approval).toHaveBeenCalledWith('is_current_login_session_approved');
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ room: `call-${callId}`, roomAdmin: false, roomRecord: false }));
  });
  it.each([{ data: false, error: null }, { data: null, error: { message: 'unavailable' } }])('denies pending/revoked/unverifiable logins before reading a call', async (result) => {
    approval.mockResolvedValue(result);
    const response = await handler(request());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('LOGIN_SECURITY_APPROVAL_REQUIRED');
    expect(from).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });
  it('denies former conversation members even with a surviving invitation', async () => {
    rows.delete('conversation_participants');
    rows.set('aegis_call_invitations', { status: 'accepted' });
    expect((await handler(request())).status).toBe(403);
    expect(mint).not.toHaveBeenCalled();
  });
  it.each([
    ['is_active', false], ['revoked_at', '2026-10-12'], ['stale_at', '2026-10-12'],
    ['crypto_invalid_at', '2026-10-12'], ['account_bound_at', null], ['approval_status', 'pending'],
    ['binding_status', 'unbound'], ['routing_status', 'repairing'],
  ])('denies a device with invalid %s', async (field, value) => {
    rows.set('user_devices', { ...rows.get('user_devices') as object, [String(field)]: value });
    expect((await handler(request())).status).toBe(403);
    expect(mint).not.toHaveBeenCalled();
    expect(deviceFilters).toContainEqual(['is', 'crypto_invalid_at', null]);
  });
  it('does not impose the private-call gate on public live viewers', async () => {
    approval.mockResolvedValue({ data: false, error: null });
    expect((await handler(request('live'))).status).toBe(200);
    expect(approval).not.toHaveBeenCalled();
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ canPublish: false, canSubscribe: true }));
  });
});
