// @vitest-environment node
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import * as risk from '../../../../supabase/functions/login-security/risk';

// Exécute le vrai handler Edge, sans réseau ni modification de comptes réels.
const compiled = ts.transpileModule(readFileSync('supabase/functions/login-security/index.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
type Row = Record<string, unknown>;
const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const token = 'a'.repeat(64);
const tokenHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
let rows: Record<string, Row[]>;
let handler: (request: Request) => Promise<Response>;
let mutations: number;
let tokenWriteFails: boolean;
let sessionReadFails: boolean;

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let values: Row | null = null;
  const q = {
    select: () => q,
    eq: (key: string, value: unknown) => { filters.push((r) => r[key] === value); return q; },
    is: (key: string, value: unknown) => { filters.push((r) => r[key] === value); return q; },
    gt: (key: string, value: string) => { filters.push((r) => String(r[key]) > value); return q; },
    update: (v: Row) => { values = v; return q; },
    insert: async (v: Row) => { (rows[table] ??= []).push(v); return { error: null }; },
    maybeSingle: async () => {
      if (table === 'login_security_email_tokens' && values && tokenWriteFails
          || table === 'login_security_sessions' && !values && sessionReadFails) {
        return { data: null, error: new Error('network') };
      }
      const row = (rows[table] ?? []).find((r) => filters.every((f) => f(r)));
      if (row && values) {
        Object.assign(row, values);
        if (table === 'login_security_sessions') mutations++;
      }
      return { data: row ? { ...row } : null, error: null };
    },
  };
  return q;
}

function send(decision = 'approve', suppliedToken = token) {
  return handler(new Request('https://edge.test/login-security', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ action: 'email_decision', token: suppliedToken, decision }),
  }));
}

beforeEach(() => {
  mutations = 0; tokenWriteFails = false; sessionReadFails = false;
  const expires = new Date(Date.now() + 60_000).toISOString();
  rows = {
    login_security_email_tokens: [{ id: 'token-id', token_hash: tokenHash, user_id: userId,
      target_session_id: sessionId, expires_at: expires, consumed_at: null, consumed_decision: null }],
    login_security_sessions: [{ user_id: userId, session_id: sessionId, status: 'pending', expires_at: expires }],
  };
  runInNewContext(compiled, {
    exports: {}, Request, Response, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: webcrypto,
    Date, atob, btoa, console,
    Deno: { env: { get: (key: string) => key === 'SITE_URL' ? 'https://forsure.fans' : 'test-only' } },
    require: (id: string) => {
      if (id.includes('http/server')) return { serve: (fn: typeof handler) => { handler = fn; } };
      if (id.startsWith('npm:')) return { createClient: () => ({ from: query, rpc: async () => ({ error: null }) }) };
      if (id.endsWith('risk.ts')) return risk;
      if (id.endsWith('cors.ts')) return { getCorsHeaders: () => ({}) };
      if (id.endsWith('network-context.ts')) return {};
      throw new Error(`Unexpected import: ${id}`);
    },
  });
});

describe('email decision Edge handler', () => {
  it('confirms only the target session, and a repeat click is idempotent', async () => {
    rows.login_security_sessions.push({ user_id: userId, session_id: 'other', status: 'pending' });
    const first = await send();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, decision: 'approve', targetSessionId: sessionId });
    expect((await send()).status).toBe(200);
    expect(mutations).toBe(1);
    expect(rows.login_security_sessions[1].status).toBe('pending');
  });
  it('recovers a token-consumption failure without executing the decision twice', async () => {
    tokenWriteFails = true;
    expect((await send()).status).toBe(200);
    expect(rows.login_security_email_tokens[0].consumed_at).toBeNull();
    tokenWriteFails = false;
    expect((await send()).status).toBe(200);
    expect(mutations).toBe(1);
    expect(rows.login_security_email_tokens[0].consumed_decision).toBe('approve');
  });
  it('never reverses a consumed decision', async () => {
    expect((await send('deny')).status).toBe(200);
    expect((await send('approve')).status).toBe(400);
    expect(rows.login_security_sessions[0].status).toBe('denied');
    expect(mutations).toBe(1);
  });
  it('accepts only one of two conflicting concurrent decisions', async () => {
    const results = await Promise.all([send('approve'), send('deny')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(mutations).toBe(1);
    expect(rows.login_security_email_tokens[0].consumed_decision).toBe(
      rows.login_security_sessions[0].status === 'approved' ? 'approve' : 'deny');
  });
  it.each(['denied', 'revoked', 'expired'])('does not revive a %s session on replay', async (status) => {
    await send();
    rows.login_security_sessions[0].status = status;
    expect((await send()).status).toBe(400);
    expect(mutations).toBe(1);
  });
  it.each(['2000-01-01T00:00:00.000Z', 'invalid'])('rejects token expiry %s', async (expires_at) => {
    rows.login_security_email_tokens[0].expires_at = expires_at;
    expect((await send()).status).toBe(400);
    expect(mutations).toBe(0);
  });
  it('fails closed when replay state cannot be read', async () => {
    await send(); sessionReadFails = true;
    expect((await send()).status).toBe(400);
    expect(mutations).toBe(1);
  });
  it('does not accept an unknown or malformed token', async () => {
    expect((await send('approve', 'b'.repeat(64))).status).toBe(400);
    expect((await send('approve', 'bad')).status).toBe(400);
    expect(mutations).toBe(0);
  });
  it('never consumes a token during a mail-link preview (GET)', async () => {
    const result = await handler(new Request(`https://edge.test/login-security?token=${token}&decision=approve`));
    expect(result.status).toBe(303);
    expect(mutations).toBe(0);
    expect(rows.login_security_email_tokens[0].consumed_at).toBeNull();
  });
});
