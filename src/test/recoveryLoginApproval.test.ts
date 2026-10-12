// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const tables = ['user_backups', 'conversation_archive_keys', 'message_archives'] as const;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const loginMigration = readFileSync('supabase/migrations/20260930011500_login_security_step_up.sql', 'utf8');
const migration = readFileSync('supabase/migrations/20261012104810_require_approved_login_for_recovery_tables.sql', 'utf8');
const archiveMigration = readFileSync('supabase/migrations/20260924153000_harden_signal_style_recovery_boundaries.sql', 'utf8');
const sessionMigration = readFileSync('supabase/migrations/20261012110211_reject_revoked_approved_login_sessions.sql', 'utf8');
const functionSql = (source: string, name: string) => {
  const match = source.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`, 'i'));
  if (!match) throw new Error(`Missing production function: ${name}`);
  return match[0];
};
let db: PGlite;

async function session(user = 1, sessionId: string | null = uid(101), role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: uid(user), session_id: sessionId, role })]);
  await db.exec(`SET ROLE ${role}`);
}

describe('Lovable Cloud recovery data requires the approved login session', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt()->>'role' $$;
      CREATE TABLE login_security_config (id smallint PRIMARY KEY, enforcement_enabled boolean);
      CREATE TABLE login_security_sessions (session_id uuid PRIMARY KEY, user_id uuid, status text, expires_at timestamptz);
      CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid, not_after timestamptz);
    `);
    // Execute the real approval predicate, including rollout and exact-session checks.
    await db.exec(functionSql(loginMigration, 'current_login_security_session_id'));
    await db.exec(functionSql(loginMigration, 'is_current_login_session_approved'));
    await db.exec(functionSql(loginMigration, 'assert_current_login_session_approved'));
    for (const table of tables) {
      // Minimal encrypted-record fixtures; retain owner-only RLS and write-once archives.
      await db.exec(`
        CREATE TABLE ${table} (id uuid PRIMARY KEY, user_id uuid, payload text,
          conversation_id uuid, wrapped_key text, kdf_version smallint, created_at timestamptz DEFAULT now());
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        GRANT SELECT, INSERT ON ${table} TO authenticated;
        GRANT ALL ON ${table} TO service_role;
        CREATE POLICY owner_select ON ${table} FOR SELECT TO authenticated USING (user_id = auth.uid());
        CREATE POLICY owner_insert ON ${table} FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
      `);
    }
    await db.exec(`
      GRANT UPDATE, DELETE ON user_backups TO authenticated;
      CREATE POLICY owner_update ON user_backups FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
      CREATE POLICY owner_delete ON user_backups FOR DELETE TO authenticated USING (user_id = auth.uid());
    `);
    await db.exec(functionSql(archiveMigration, 'get_user_archive_keys'));
    await db.exec(migration);
    await db.exec(sessionMigration);
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.exec(`RESET ROLE;
      TRUNCATE login_security_config, login_security_sessions, auth.sessions;
      INSERT INTO login_security_config VALUES (1, true);
      INSERT INTO login_security_sessions VALUES ('${uid(101)}', '${uid(1)}', 'pending', now() + interval '1 day');
      INSERT INTO auth.sessions VALUES ('${uid(101)}', '${uid(1)}', null);
    `);
    for (const table of tables) {
      await db.exec(`TRUNCATE ${table}; INSERT INTO ${table}(id,user_id,payload) VALUES
        ('${uid(11)}','${uid(1)}','opaque-owner'), ('${uid(12)}','${uid(2)}','opaque-other');`);
    }
  });

  it.each(tables)('denies pending-session reads and inserts on %s', async (table) => {
    await session();
    await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    await expect(db.query(`INSERT INTO ${table}(id,user_id,payload) VALUES ($1,$2,'new')`, [uid(13), uid(1)]))
      .rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
  });

  it.each(['denied', 'expired', 'missing', 'expired_approval', 'wrong_session', 'missing_session', 'wrong_user'])(
    'fails closed for %s even with the correct account id', async (condition) => {
      if (condition === 'missing') await db.exec('DELETE FROM login_security_sessions');
      else await db.query('UPDATE login_security_sessions SET status=$1', [condition === 'denied' || condition === 'expired' ? condition : 'approved']);
      if (condition === 'expired_approval') await db.exec("UPDATE login_security_sessions SET expires_at=now()-interval '1 minute'");
      await session(condition === 'wrong_user' ? 2 : 1, condition === 'missing_session' ? null : uid(condition === 'wrong_session' ? 102 : 101));
      for (const table of tables) await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
      await expect(db.query('SELECT * FROM get_user_archive_keys()')).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    });

  it('allows recovery immediately after approval without broadening owner access', async () => {
    await session();
    await expect(db.query('SELECT * FROM user_backups')).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    await db.exec("RESET ROLE; UPDATE login_security_sessions SET status='approved'");
    await session();
    for (const table of tables) {
      expect((await db.query(`SELECT payload FROM ${table}`)).rows).toEqual([{ payload: 'opaque-owner' }]);
      await db.query(`INSERT INTO ${table}(id,user_id,payload) VALUES ($1,$2,'new')`, [uid(13), uid(1)]);
      await expect(db.query(`INSERT INTO ${table}(id,user_id,payload) VALUES ($1,$2,'foreign')`, [uid(14), uid(2)]))
        .rejects.toThrow(/row-level security/i);
    }
    expect((await db.query('SELECT * FROM get_user_archive_keys()')).rows).toHaveLength(2);
  });

  it('blocks backup overwrites/deletion until approved and preserves write-once archives', async () => {
    await session();
    await expect(db.query("UPDATE user_backups SET payload='changed' RETURNING id")).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    await expect(db.query('DELETE FROM user_backups RETURNING id')).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    await db.exec("RESET ROLE; UPDATE login_security_sessions SET status='approved'");
    await session();
    expect((await db.query("UPDATE user_backups SET payload='changed' RETURNING id")).rows).toEqual([{ id: uid(11) }]);
    for (const table of tables.slice(1)) {
      await expect(db.query(`UPDATE ${table} SET payload='changed'`)).rejects.toThrow(/permission denied/i);
      await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/i);
    }
    expect((await db.query('DELETE FROM user_backups RETURNING id')).rows).toEqual([{ id: uid(11) }]);
  });

  it('preserves staged rollout and does not grant anonymous access', async () => {
    await db.exec('UPDATE login_security_config SET enforcement_enabled=false');
    await session();
    for (const table of tables) expect((await db.query(`SELECT payload FROM ${table}`)).rows).toEqual([{ payload: 'opaque-owner' }]);
    await session(1, null, 'anon');
    for (const table of tables) await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/i);
  });

  it('does not interfere with service-role maintenance', async () => {
    await session(1, null, 'service_role');
    for (const table of tables) expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(2);
  });

  it.each(['deleted', 'wrong_owner', 'expired'])('denies a still-approved login whose Auth session is %s', async (state) => {
    await db.exec("UPDATE login_security_sessions SET status='approved'");
    if (state === 'deleted') await db.exec('DELETE FROM auth.sessions');
    if (state === 'wrong_owner') await db.query('UPDATE auth.sessions SET user_id=$1', [uid(2)]);
    if (state === 'expired') await db.exec("UPDATE auth.sessions SET not_after=now()-interval '1 second'");
    await session();
    expect((await db.query('SELECT is_current_login_session_approved() AS approved')).rows).toEqual([{ approved: false }]);
    for (const table of tables) await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
  });

  it('does not confuse a hidden backup with an absent one during a cold-start probe', async () => {
    await session();
    await expect(db.query('SELECT id FROM user_backups WHERE user_id=$1 LIMIT 1', [uid(1)]))
      .rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    await db.exec("RESET ROLE; UPDATE login_security_sessions SET status='approved'");
    await session();
    expect((await db.query('SELECT id FROM user_backups WHERE user_id=$1 LIMIT 1', [uid(1)])).rows).toEqual([{ id: uid(11) }]);
  });
});
