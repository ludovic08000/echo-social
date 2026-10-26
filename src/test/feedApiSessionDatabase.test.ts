// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

let db: PGlite;
const userId = '00000000-0000-4000-8000-000000000001';
const otherUserId = '00000000-0000-4000-8000-000000000002';
const sessionId = '00000000-0000-4000-8000-000000000003';
const migration = readFileSync('supabase/migrations/20261026170313_feed_api_active_session_authority.sql', 'utf8');
const claims = async (value: unknown) => {
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(value)]);
};
const active = async () => (await db.query<{ active: boolean }>('select public.feed_api_session_active() as active')).rows[0].active;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.sessions(id uuid primary key, user_id uuid not null, not_after timestamptz);
    alter table auth.sessions enable row level security;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema auth to anon, authenticated, service_role;
  `);
  await db.exec(migration);
}, 30000);

beforeEach(async () => {
  await db.exec(`reset role; truncate auth.sessions;
    insert into auth.sessions values ('${sessionId}', '${userId}', null);
    set role authenticated`);
  await claims({ sub: userId, session_id: sessionId, role: 'authenticated' });
});
afterAll(async () => { await db?.close(); });

it('allows a real session belonging to the verified caller without granting access to Auth rows', async () => {
  expect(await active()).toBe(true);
  await expect(db.query('select * from auth.sessions')).rejects.toThrow(/permission denied/);
  await expect(db.query('delete from auth.sessions')).rejects.toThrow(/permission denied/);
});

it('rejects a still-unexpired token immediately on the next check after its session is removed', async () => {
  expect(await active()).toBe(true);
  await db.exec(`reset role; delete from auth.sessions where id = '${sessionId}'; set role authenticated`);
  expect(await active()).toBe(false); // Same signed claims; no cache or token-expiry wait.
});

it('cannot use a session belonging to another account or a user_metadata claim to override ownership', async () => {
  await claims({ sub: otherUserId, session_id: sessionId, role: 'authenticated',
    user_metadata: { sub: userId, role: 'service_role', session_id: sessionId } });
  expect(await active()).toBe(false);
  await expect(db.query('select public.feed_api_session_active($1, $2)', [userId, sessionId])).rejects.toThrow(/does not exist/);
});

it.each([null, '', 'invalid', "x' OR true --", {}, ['bad'], '00000000-0000-4000-8000-000000000099'])(
  'rejects absent, malformed or unknown session claim %j', async session => {
    await claims({ sub: userId, session_id: session, role: 'authenticated' });
    expect(await active()).toBe(false);
  },
);

it('honors a server-enforced expiry while retaining sessions without a maximum lifetime', async () => {
  await db.exec("reset role; update auth.sessions set not_after = now() - interval '1 second'; set role authenticated");
  expect(await active()).toBe(false);
  await db.exec("reset role; update auth.sessions set not_after = now() + interval '1 hour'; set role authenticated");
  expect(await active()).toBe(true);
});

it('does not grant anonymous/service callers a public session oracle', async () => {
  for (const role of ['anon', 'service_role']) {
    await db.exec(`set role ${role}`);
    await expect(active()).rejects.toThrow(/permission denied/);
  }
  await db.exec('set role authenticated');
  await claims({ role: 'authenticated', session_id: sessionId });
  expect(await active()).toBe(false);
  await claims({ role: 'service_role', sub: userId, session_id: sessionId });
  expect(await active()).toBe(false);
});

it('uses an empty search path and resists shadowing the Auth session table', async () => {
  await db.exec(`reset role;
    create temporary table sessions(id uuid, user_id uuid, not_after timestamptz);
    insert into sessions values ('${sessionId}', '${otherUserId}', null);
    set role authenticated; set search_path = pg_temp, public`);
  await claims({ sub: otherUserId, session_id: sessionId, role: 'authenticated' });
  expect(await active()).toBe(false);
  const { rows } = await db.query<{ proconfig: string[]; prosecdef: boolean }>(
    "select proconfig, prosecdef from pg_proc where oid = 'public.feed_api_session_active()'::regprocedure",
  );
  expect(rows[0]).toEqual({ proconfig: ['search_path=""'], prosecdef: true });
});

it('is additive and repeatable without changing existing login, device or session rows', async () => {
  await db.exec('reset role');
  const before = (await db.query('select * from auth.sessions')).rows;
  await db.exec(migration);
  expect((await db.query('select * from auth.sessions')).rows).toEqual(before);
  await db.exec('set role authenticated');
  expect(await active()).toBe(true);
});
