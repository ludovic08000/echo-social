// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const source = readFileSync('supabase/functions/admin-delete-user/index.ts', 'utf8');
const code = ts.transpileModule(source.replace(/^import[^;]+;\r?\n/gm, ''), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const callerId = '00000000-0000-4000-8000-000000000010';
const targetId = '00000000-0000-4000-8000-000000000020';
function fixture(options: { denied?: boolean; role?: boolean; roleError?: boolean; deleteError?: unknown; check?: unknown; throws?: boolean } = {}) {
  let handler: (req: Request) => Promise<Response> = async () => new Response();
  const deleted = vi.fn(async () => { if (options.throws) throw new Error('synthetic private detail'); return { data: { user: {} }, error: options.deleteError ?? null }; });
  const checked = vi.fn(async () => options.check ?? { data: { user: null }, error: { status: 404, code: 'user_not_found' } });
  const from = vi.fn(() => { throw new Error('No application table mutations permitted'); });
  const rpc = vi.fn(async () => ({ data: options.role ?? true, error: options.roleError ? new Error('synthetic') : null }));
  const create = vi.fn(() => ({ rpc, from, auth: { admin: { deleteUser: deleted, getUserById: checked } } }));
  new Function('Deno', 'createClient', 'requireAuthenticated', 'getCorsHeaders', code)(
    { serve: (fn: typeof handler) => { handler = fn; }, env: { get: () => 'synthetic-config' } }, create,
    async () => options.denied ? { ok: false, response: new Response(null, { status: 401 }) } : { ok: true, userId: callerId }, () => ({}),
  );
  return { deleted, checked, from, create, rpc, send: (body: unknown = { target_user_id: targetId }, method = 'POST') => handler(new Request('https://local.invalid', { method, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })) };
}
it('requires an authenticated administrator before any destructive API call', async () => {
  const invalid = fixture({ denied: true }); expect((await invalid.send()).status).toBe(401); expect(invalid.create).not.toHaveBeenCalled();
  for (const options of [{ role: false }, { roleError: true }]) {
    const f = fixture(options); expect((await f.send()).status).toBe(403); expect(f.deleted).not.toHaveBeenCalled();
  }
});
it('rejects unsafe methods, malformed requests, self-deletion and the system account', async () => {
  const f = fixture(); expect((await f.send(undefined, 'GET')).status).toBe(405);
  for (const body of ['{', null, [], { target_user_id: 'arbitrary' }, { target_user_id: callerId.toUpperCase() }]) expect((await f.send(body)).status).toBe(400);
  expect((await f.send({ target_user_id: '00000000-0000-0000-0000-000000000001' })).status).toBe(403);
  expect(f.deleted).not.toHaveBeenCalled();
});
it('never pre-deletes application data or announces success after a failed Auth deletion', async () => {
  const f = fixture({ deleteError: { status: 500, message: 'private foreign key detail' } });
  const response = await f.send(); expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'ACCOUNT_DELETION_NOT_CONFIRMED' });
  expect(f.from).not.toHaveBeenCalled(); expect(f.checked).not.toHaveBeenCalled();
  expect(source).not.toContain('.delete()');
});
it('does not label an already missing account as a new deletion', async () => {
  const f = fixture({ deleteError: { status: 404, code: 'user_not_found' } }); expect((await f.send()).status).toBe(404); expect(f.from).not.toHaveBeenCalled();
});
it('confirms Auth absence after its empty response without promising storage erasure', async () => {
  const f = fixture(); const response = await f.send(); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, auth_deleted: true, storage_cleanup: 'not_performed' });
  expect(f.deleted).toHaveBeenCalledExactlyOnceWith(targetId, false); expect(f.checked).toHaveBeenCalledExactlyOnceWith(targetId); expect(f.from).not.toHaveBeenCalled();
});
it.each([
  { data: { user: null }, error: null },
  { data: { user: { id: targetId } }, error: null },
  { data: { user: null }, error: { status: 503 } },
  { data: { user: null }, error: { status: 404, code: 'unexpected_gateway_route' } },
])('treats a missing, contradictory or failed authority read as unknown: %j', async check => {
  const f = fixture({ check }); const response = await f.send(); expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'ACCOUNT_DELETION_UNKNOWN' }); expect(f.from).not.toHaveBeenCalled();
});
it('never leaks private errors nor treats a response loss as proof of no deletion', async () => {
  const response = await fixture({ throws: true }).send(); expect(response.status).toBe(503);
  const body = await response.text(); expect(body).toContain('ACCOUNT_DELETION_UNKNOWN'); expect(body).not.toContain('synthetic private');
});
it('database cascades roll back with Auth deletion if a retained reference forbids it', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema auth; create table auth.users(id uuid primary key);
      create table profiles(user_id uuid references auth.users on delete cascade, name text);
      create table retention(user_id uuid references auth.users);
      insert into auth.users values('${targetId}'); insert into profiles values('${targetId}','synthetic'); insert into retention values('${targetId}');`);
    await expect(db.exec(`begin; delete from auth.users where id='${targetId}'; commit;`)).rejects.toThrow(); await db.exec('rollback;');
    expect((await db.query('select * from profiles')).rows).toHaveLength(1);
    expect((await db.query('select * from auth.users')).rows).toHaveLength(1);
    await db.exec(`delete from retention; begin; delete from auth.users where id='${targetId}'; commit;`);
    expect((await db.query('select * from profiles')).rows).toHaveLength(0);
  } finally { await db.close(); }
});
