// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const migration = readFileSync('supabase/migrations/20261012105635_protect_libsignal_prekey_availability.sql', 'utf8');
let db: PGlite;
async function asUser(user = 1, approved = true) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('test.uid',$1,false), set_config('test.approved',$2,false)", [uid(user), String(approved)]);
  await db.exec('SET ROLE authenticated');
}
async function claim(conversation = 10, device = 'recipient-device', sender = 'sender-device', recipient = 2) {
  return (await db.query('SELECT * FROM claim_libsignal_prekey_bundle($1,$2,$3,$4)', [uid(recipient), device, uid(conversation), sender])).rows;
}
async function stock() {
  await db.exec('RESET ROLE');
  return (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM device_libsignal_prekey_bundles')).rows[0].count;
}

describe('prekey exhaustion must not revoke established routes', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth,public TO anon,authenticated,service_role;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
      CREATE TABLE user_devices(user_id uuid, device_id text, approval_status text DEFAULT 'approved', is_active boolean DEFAULT true,
        revoked_at timestamptz, stale_at timestamptz, crypto_invalid_at timestamptz, binding_status text DEFAULT 'bound',
        account_bound_at timestamptz DEFAULT now(), routing_status text DEFAULT 'ready', libsignal_device_number smallint DEFAULT 1,
        device_public_key text DEFAULT 'kx', device_signing_key text DEFAULT 'sign', device_authorization_signature text DEFAULT 'valid',
        last_seen_at timestamptz DEFAULT now(), PRIMARY KEY(user_id,device_id));
      CREATE TABLE user_public_keys(user_id uuid, identity_key text DEFAULT 'identity', signing_key text DEFAULT 'sign',
        fingerprint text DEFAULT 'fingerprint', identity_binding_signature text DEFAULT 'valid', identity_binding_version integer DEFAULT 1,
        is_active boolean DEFAULT true, created_at timestamptz DEFAULT now());
      CREATE TABLE conversation_participants(conversation_id uuid,user_id uuid);
      CREATE TABLE device_libsignal_prekey_bundles(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,user_id uuid,device_id text,
        device_number smallint DEFAULT 1, registration_id bigint DEFAULT 42, prekey_id bigint, public_bundle text,
        created_at timestamptz DEFAULT now());
      CREATE TABLE test_blocks(sender uuid, recipient uuid);
      CREATE FUNCTION aegis_verify_account_binding(text,text,text,text,integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT $4='valid' $$;
      CREATE FUNCTION aegis_verify_device_authorization(uuid,text,text,text,text,text,text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT $5='valid' $$;
      CREATE FUNCTION aegis_message_block_reason(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS $$
        SELECT 'blocked'::text FROM test_blocks WHERE sender=$1 AND recipient=$2 LIMIT 1 $$;
      CREATE FUNCTION assert_current_login_session_approved() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('test.approved',true) IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LOGIN_APPROVAL_REQUIRED'; END IF; END $$;
    `);
    // Real routing/claim SQL; signature primitives and login service are isolated fixtures.
    await db.exec(migration);
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.exec(`RESET ROLE;
      TRUNCATE libsignal_prekey_claim_limits, device_libsignal_prekey_bundles, user_devices, auth.users,
        user_public_keys, conversation_participants, test_blocks;
      INSERT INTO auth.users VALUES ('${uid(1)}'),('${uid(2)}'),('${uid(3)}');
      INSERT INTO user_devices(user_id,device_id) VALUES ('${uid(1)}','sender-device'),('${uid(1)}','second-sender'),('${uid(2)}','recipient-device');
      INSERT INTO user_public_keys(user_id) VALUES ('${uid(1)}'),('${uid(2)}');
      INSERT INTO conversation_participants VALUES ('${uid(10)}','${uid(1)}'),('${uid(10)}','${uid(2)}'),
        ('${uid(11)}','${uid(1)}'),('${uid(11)}','${uid(2)}');
      INSERT INTO device_libsignal_prekey_bundles(user_id,device_id,prekey_id,public_bundle)
        SELECT '${uid(2)}','recipient-device',n,repeat('b',100)||n FROM generate_series(1,20) n;
    `);
    await asUser();
  });

  it('keeps an authenticated bound device routable with zero prekeys', async () => {
    await db.exec('RESET ROLE; DELETE FROM device_libsignal_prekey_bundles');
    await asUser();
    expect((await db.query('SELECT is_routable FROM get_sesame_device_list($1)', [uid(2)])).rows).toEqual([{ is_routable: true }]);
    expect(await claim()).toEqual([]);
  });

  it.each([
    "approval_status='pending'", 'is_active=false', 'revoked_at=now()', 'stale_at=now()', 'crypto_invalid_at=now()',
    "binding_status='unbound'", 'account_bound_at=null', "routing_status='repairing'", 'libsignal_device_number=null',
    "device_authorization_signature='invalid'", "device_public_key=''",
  ])('does not route or claim from an invalid device: %s', async (mutation) => {
    await db.exec(`RESET ROLE; UPDATE user_devices SET ${mutation} WHERE user_id='${uid(2)}'`);
    await asUser();
    expect((await db.query('SELECT device_id FROM get_sesame_device_list($1) WHERE is_routable', [uid(2)])).rows).toEqual([]);
    expect(await claim()).toEqual([]);
    expect(await stock()).toBe(20);
  });

  it('rejects a forged account binding', async () => {
    await db.exec("RESET ROLE; UPDATE user_public_keys SET identity_binding_signature='invalid'");
    await asUser();
    expect(await claim()).toEqual([]);
    expect(await stock()).toBe(20);
  });

  it('consumes unique bundles and caps one account across its conversations and devices', async () => {
    const bundles = [];
    for (let n = 0; n < 4; n++) bundles.push(...await claim(n % 2 ? 11 : 10, 'recipient-device', n % 2 ? 'second-sender' : 'sender-device'));
    expect(new Set(bundles.map((b) => b.public_bundle)).size).toBe(4);
    await expect(claim()).rejects.toThrow('AEGIS_LIBSIGNAL_PREKEY_RATE_LIMITED');
    expect(await stock()).toBe(16);
  });

  it('allows a new window and does not count an empty inventory as consumption', async () => {
    for (let n = 0; n < 4; n++) await claim();
    await db.exec("RESET ROLE; UPDATE libsignal_prekey_claim_limits SET window_started_at=now()-interval '11 minutes'");
    await asUser();
    expect(await claim()).toHaveLength(1);
    await db.exec('RESET ROLE; DELETE FROM device_libsignal_prekey_bundles');
    await asUser();
    for (let n = 0; n < 8; n++) expect(await claim()).toEqual([]);
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT claims FROM libsignal_prekey_claim_limits')).rows).toEqual([{ claims: 1 }]);
  });

  it('denies unapproved logins, nonmembers, blocked peers and invalid sender devices', async () => {
    await asUser(1, false);
    await expect(claim()).rejects.toThrow('LOGIN_APPROVAL_REQUIRED');
    await asUser(3);
    expect(await claim()).toEqual([]);
    await asUser();
    expect(await claim(99)).toEqual([]);
    expect(await claim(10, 'recipient-device', 'forged-device')).toEqual([]);
    await db.exec(`RESET ROLE; INSERT INTO test_blocks VALUES ('${uid(1)}','${uid(2)}')`);
    await asUser();
    expect(await claim()).toEqual([]);
    expect(await stock()).toBe(20);
  });

  it('rejects direct quota manipulation and anonymous bundle claims', async () => {
    await expect(db.exec('SELECT * FROM libsignal_prekey_claim_limits')).rejects.toThrow(/permission denied/i);
    await expect(db.exec('DELETE FROM libsignal_prekey_claim_limits')).rejects.toThrow(/permission denied/i);
    await db.exec('RESET ROLE; SET ROLE anon');
    await expect(claim()).rejects.toThrow(/permission denied/i);
  });
});
