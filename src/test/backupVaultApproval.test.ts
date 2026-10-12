// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync('supabase/functions/e2ee-backup-vault/index.ts', 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const backup = { encrypted_blob: 'opaque', iv: 'iv', salt: 'salt', wrapped_master_key: 'wrapped',
  master_key_iv: 'mk-iv', backup_type: 'account', created_at: '2026-10-12T10:00:00Z' };
const claims = vi.fn();
const rpc = vi.fn();
const network = vi.fn();
const rateLimit = vi.fn();
const createClient = vi.fn();
let handler: (req: Request) => Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  claims.mockResolvedValue({ data: { claims: { sub: 'owner-id' } }, error: null });
  rpc.mockResolvedValue({ data: true, error: null });
  rateLimit.mockResolvedValue(null);
  network.mockImplementation(async () => new Response(JSON.stringify({ backup }), { status: 200 }));
  createClient.mockReturnValue({ auth: { getClaims: claims }, rpc });
  runInNewContext(code, {
    exports: {}, Request, Response, TextEncoder, TextDecoder, crypto, Uint8Array, ArrayBuffer,
    console: { error: vi.fn() }, fetch: network,
    Deno: {
      serve: (callback: typeof handler) => { handler = callback; },
      env: { get: (name: string) => ({
        SUPABASE_URL: 'https://test.invalid', SUPABASE_ANON_KEY: 'test-anon',
        R2_BACKUP_NAMESPACE_SECRET: 'test-namespace-secret-not-real-123456789',
        R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test-access', R2_SECRET_ACCESS_KEY: 'test-secret',
        R2_BACKUP_BUCKET_NAME: 'test-backup',
      }[name]) },
    },
    require: (name: string) => {
      if (name === 'https://esm.sh/@supabase/supabase-js@2') return { createClient };
      if (name === '../_shared/rate-limit.ts') return { checkRateLimit: rateLimit };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
});
const request = (action: string, token = 'test-jwt') => new Request('https://test.invalid/vault', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ action, backup_type: 'account', backup, user_id: 'forged-owner' }),
});

describe('actual backup vault handler, with isolated Auth and R2 transports', () => {
  it.each(['get', 'put', 'delete'])('denies %s before touching R2 when login approval is missing', async (action) => {
    rpc.mockResolvedValue({ data: false, error: null });
    const response = await handler(request(action));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'LOGIN_SECURITY_APPROVAL_REQUIRED' });
    expect(network).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
  });
  it.each(['get', 'put', 'delete'])('allows approved %s and uses the verified JWT, never a body identity', async (action) => {
    const response = await handler(request(action));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('is_current_login_session_approved');
    expect(createClient).toHaveBeenCalledWith('https://test.invalid', 'test-anon', {
      global: { headers: { Authorization: 'Bearer test-jwt' } },
    });
    expect(rateLimit.mock.calls[0][0]).toBe('e2ee-backup-vault:owner-id');
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][0]).toMatch(/e2ee-backups\/current\/[a-f0-9]{64}\/account\/latest.enc$/);
    expect(network.mock.calls[0][1].method).toBe(action.toUpperCase());
  });
  it.each([{ data: null, error: { message: 'offline' } }, { data: null, error: null }])('fails closed when approval cannot be determined', async (result) => {
    rpc.mockResolvedValue(result);
    expect((await handler(request('get'))).status).toBe(403);
    expect(network).not.toHaveBeenCalled();
  });
  it('does not consult approval or R2 for an invalid JWT', async () => {
    claims.mockResolvedValue({ data: null, error: { message: 'invalid' } });
    expect((await handler(request('get'))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
