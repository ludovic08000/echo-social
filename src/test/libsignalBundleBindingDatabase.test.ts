// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { libsignalBundleBindingPayload, signLibsignalBundleBinding } from '../lib/crypto/libsignalBundleBinding';
import * as wasm from '../lib/crypto/wasm/generated/aegis_crypto';

const uid = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let db:PGlite; let key:CryptoKeyPair; let publicKey:string;
let bundle:string; let proof:string;
async function asUser(n=2, revision='1', approved=true) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('test.uid',$1,false),set_config('test.approved',$2,false),set_config('request.headers',$3,false)",
    [uid(n),String(approved),JSON.stringify({'x-forsure-messaging-revision':revision})]);
  await db.exec('SET ROLE authenticated');
}
const context = () => ({userId:uid(2),deviceId:'ios',deviceNumber:2,registrationId:202,publicBundle:bundle});
async function publish(signature=proof, publicBundle=bundle, device='ios') {
  return db.query('SELECT publish_libsignal_prekey_bundle($1,2,202,11,12,13,$2,$3) AS result',[device,publicBundle,signature]);
}
async function claim(conversation=10) {
  return db.query('SELECT * FROM claim_libsignal_prekey_bundle($1,$2,$3,$4)',[uid(2),'ios',uid(conversation),'windows']);
}

describe('strict device-bound prekey migration in PostgreSQL', () => {
  beforeAll(async () => {
    await wasm.default({module_or_path:readFileSync('src/lib/crypto/wasm/generated/aegis_crypto_bg.wasm')});
    const packed = await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(202),2,11,12,13);
    const length = new DataView(packed.buffer,packed.byteOffset,4).getUint32(0,true);
    bundle = Buffer.from(packed.slice(length+8)).toString('base64');
    key = await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
    publicKey = Buffer.from(await crypto.subtle.exportKey('raw',key.publicKey)).toString('base64');
    proof = await signLibsignalBundleBinding(context(),key.privateKey);
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth,public TO anon,authenticated,service_role;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
      CREATE TABLE user_devices(user_id uuid,device_id text,libsignal_device_number smallint,
        approval_status text DEFAULT 'approved',is_active boolean DEFAULT true,revoked_at timestamptz,stale_at timestamptz,
        crypto_invalid_at timestamptz,binding_status text DEFAULT 'bound',account_bound_at timestamptz DEFAULT now(),
        routing_status text DEFAULT 'ready',device_public_key text DEFAULT 'kx',device_signing_key text,
        device_authorization_signature text DEFAULT 'valid',last_seen_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,device_id));
      CREATE TABLE user_public_keys(user_id uuid,identity_key text DEFAULT 'identity',signing_key text DEFAULT 'sign',
        fingerprint text DEFAULT 'fingerprint',identity_binding_signature text DEFAULT 'valid',identity_binding_version integer DEFAULT 1,
        is_active boolean DEFAULT true,created_at timestamptz DEFAULT now());
      CREATE TABLE conversation_participants(conversation_id uuid,user_id uuid);
      CREATE TABLE device_libsignal_prekey_bundles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,device_id text,
        device_number smallint,registration_id bigint,prekey_id bigint,signed_prekey_id bigint,kyber_prekey_id bigint,
        public_bundle text,created_at timestamptz DEFAULT now(),UNIQUE(user_id,device_id,prekey_id));
      ALTER TABLE device_libsignal_prekey_bundles ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON device_libsignal_prekey_bundles FROM public,anon,authenticated;
      CREATE TABLE test_blocks(sender uuid,recipient uuid);
      CREATE FUNCTION aegis_verify_account_binding(text,text,text,text,integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT $4='valid' $$;
      CREATE FUNCTION aegis_verify_device_authorization(uuid,text,text,text,text,text,text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT $5='valid' $$;
      CREATE FUNCTION aegis_message_block_reason(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS $$
        SELECT 'blocked'::text FROM test_blocks WHERE sender=$1 AND recipient=$2 LIMIT 1 $$;
      CREATE FUNCTION assert_current_login_session_approved() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('test.approved',true) IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LOGIN_SECURITY_APPROVAL_REQUIRED'; END IF; END $$;
      CREATE FUNCTION count_libsignal_prekey_bundles(text) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
      CREATE FUNCTION publish_libsignal_prekey_bundle(text,integer,bigint,bigint,bigint,bigint,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION aegis_decode_base64(text) RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN RETURN decode($1,'base64'); EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;
      CREATE TABLE test_valid_signatures(key text,signature text,payload bytea);
      -- PGlite n'embarque pas pgsodium : seuls les triplets vérifiés par WebCrypto
      -- sont admis ici. Le SQL métier est exécuté sans remplacement.
      CREATE FUNCTION aegis_verify_ed25519(text,text,bytea) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM test_valid_signatures WHERE key=$1 AND signature=$2 AND payload=$3) $$;
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sender_id uuid);
      CREATE TABLE message_device_copies(message_id uuid,recipient_user_id uuid,sender_user_id uuid,sender_device_id text);
      CREATE TABLE active_calls(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      GRANT INSERT,SELECT ON messages,active_calls TO authenticated;
    `);
    await db.exec(readFileSync('supabase/migrations/20261012105635_protect_libsignal_prekey_availability.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261012112352_bind_libsignal_bundles_to_approved_devices.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261012134736_persist_libsignal_receive_attestations.sql','utf8'));
    const payload = libsignalBundleBindingPayload(context());
    expect(await crypto.subtle.verify('Ed25519',key.publicKey,Buffer.from(proof,'base64'),new TextEncoder().encode(payload))).toBe(true);
    await db.query('INSERT INTO test_valid_signatures VALUES($1,$2,$3)',[publicKey,proof,new TextEncoder().encode(payload)]);
  },30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.exec(`RESET ROLE; TRUNCATE libsignal_receive_attestations,message_device_copies,libsignal_prekey_claim_limits,device_libsignal_prekey_bundles,user_devices,
      auth.users,user_public_keys,conversation_participants,test_blocks,messages,active_calls;
      INSERT INTO auth.users VALUES('${uid(1)}'),('${uid(2)}'),('${uid(3)}');
      INSERT INTO user_public_keys(user_id) VALUES('${uid(1)}'),('${uid(2)}');
      INSERT INTO conversation_participants VALUES('${uid(10)}','${uid(1)}'),('${uid(10)}','${uid(2)}');`);
    await db.query('INSERT INTO user_devices(user_id,device_id,libsignal_device_number,device_signing_key) VALUES($1,$2,1,$3),($4,$5,2,$3)',
      [uid(1),'windows',publicKey,uid(2),'ios']);
    await asUser();
  });
  it('matches the client canonical signature bytes exactly',async () => {
    await db.exec('RESET ROLE');
    const row = await db.query<{payload:string}>('SELECT libsignal_bundle_binding_payload($1,$2,2,202,$3) AS payload',[uid(2),'ios',bundle]);
    expect(row.rows[0].payload).toBe(libsignalBundleBindingPayload(context()));
  });
  it('publishes, counts and claims the real signed WASM bundle without changing route state',async () => {
    await db.exec("RESET ROLE; UPDATE user_devices SET routing_status='repairing' WHERE device_id='ios'");
    await asUser();
    expect((await publish()).rows).toEqual([{result:{ok:true,code:'LIBSIGNAL_BUNDLE_PUBLISHED'}}]);
    expect((await db.query('SELECT get_libsignal_prekey_inventory($1) AS inventory',['ios'])).rows).toEqual([{inventory:{total:1,verified:1}}]);
    await db.exec('RESET ROLE');
    expect((await db.query("SELECT routing_status FROM user_devices WHERE device_id='ios'")).rows[0]).toEqual({routing_status:'repairing'});
    await db.exec("UPDATE user_devices SET routing_status='ready' WHERE device_id='ios'");
    await asUser(1);
    expect((await claim()).rows).toEqual([{device_number:2,registration_id:202,public_bundle:bundle,bundle_signature:proof}]);
    expect((await claim()).rows).toEqual([]);
  });
  it('is idempotent for the same bundle and never duplicates its proof',async () => {
    await publish(); await publish();
    expect((await db.query('SELECT get_libsignal_prekey_inventory($1) AS inventory',['ios'])).rows).toEqual([{inventory:{total:1,verified:1}}]);
  });
  it.each(['','0','2','garbage'])('rejects unsupported revision %s before writes',async (revision) => {
    await asUser(2,revision);
    await expect(publish()).rejects.toThrow('CLIENT_UPDATE_REQUIRED');
    await expect(db.exec('INSERT INTO messages DEFAULT VALUES')).rejects.toThrow('CLIENT_UPDATE_REQUIRED');
    await expect(db.exec('INSERT INTO active_calls DEFAULT VALUES')).rejects.toThrow('CLIENT_UPDATE_REQUIRED');
    // Pas de blocage de la lecture de l'historique.
    expect((await db.query('SELECT * FROM messages')).rows).toEqual([]);
  });
  it('does not accept a revision header in place of a missing cryptographic proof',async () => {
    await expect(db.query('SELECT publish_libsignal_prekey_bundle($1,2,202,11,12,13,$2)',['ios',bundle])).rejects.toThrow('CLIENT_UPDATE_REQUIRED');
    await expect(publish('A'.repeat(88))).rejects.toThrow('BUNDLE_BINDING_INVALID');
  });
  it('rejects metadata mismatch, truncation and noncanonical base64',async () => {
    await expect(db.query('SELECT publish_libsignal_prekey_bundle($1,2,404,11,12,13,$2,$3)',['ios',bundle,proof])).rejects.toThrow('INVALID_LIBSIGNAL_BUNDLE');
    await expect(publish(proof,bundle.slice(0,-4))).rejects.toThrow('INVALID_LIBSIGNAL_BUNDLE');
    await expect(publish(proof,bundle+'\n')).rejects.toThrow('INVALID_LIBSIGNAL_BUNDLE');
  });
  it('keeps unsigned stock for continuity but never returns it as authenticated',async () => {
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO device_libsignal_prekey_bundles(user_id,device_id,device_number,registration_id,prekey_id,signed_prekey_id,kyber_prekey_id,public_bundle) VALUES($1,$2,2,202,11,12,13,$3)',[uid(2),'ios',bundle]);
    await asUser();
    expect((await db.query('SELECT get_libsignal_prekey_inventory($1) AS inventory',['ios'])).rows).toEqual([{inventory:{total:1,verified:0}}]);
    await asUser(1);
    await expect(claim()).rejects.toThrow('PEER_DEVICE_UPDATE_REQUIRED');
    await asUser();
    await publish(); // adoption avec preuve réelle, aucune réécriture privée
    await asUser(1);
    expect((await claim()).rows).toHaveLength(1);
  });
  it.each(["approval_status='pending'","is_active=false","revoked_at=now()","stale_at=now()",
    "crypto_invalid_at=now()","binding_status='unbound'","account_bound_at=null","device_authorization_signature='invalid'"])(
    'rejects a device that is not approved and bound: %s',async (mutation) => {
      await db.exec(`RESET ROLE; UPDATE user_devices SET ${mutation} WHERE device_id='ios'`); await asUser();
      await expect(publish()).rejects.toThrow('DEVICE_NOT_AUTHORIZED');
    });
  it('rejects unapproved login, another owner and direct writes',async () => {
    await asUser(2,'1',false); await expect(publish()).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    await asUser(1); await expect(publish()).rejects.toThrow('DEVICE_NOT_AUTHORIZED');
    await asUser(); await expect(db.exec('DELETE FROM device_libsignal_prekey_bundles')).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE; SET ROLE anon'); await expect(publish()).rejects.toThrow(/permission denied/);
  });
  it('preserves member, blocking and claim quota checks',async () => {
    await publish(); await asUser(3); expect((await claim()).rows).toEqual([]);
    await asUser(1); expect((await claim(99)).rows).toEqual([]);
    await db.exec(`RESET ROLE; INSERT INTO test_blocks VALUES('${uid(1)}','${uid(2)}')`);
    await asUser(1); expect((await claim()).rows).toEqual([]);
    await db.exec(`RESET ROLE; DELETE FROM test_blocks;
      INSERT INTO libsignal_prekey_claim_limits(claimer_user_id,recipient_user_id,recipient_device_id,claims)
      VALUES('${uid(1)}','${uid(2)}','ios',4)`);
    await asUser(1); await expect(claim()).rejects.toThrow('PREKEY_RATE_LIMITED');
  });
  it('rechecks proof integrity when claiming after storage tampering',async () => {
    await publish();
    await db.exec('RESET ROLE');
    await expect(db.exec("UPDATE device_libsignal_prekey_bundles SET bundle_signature=repeat('A',88)")).rejects.toThrow('BUNDLE_BINDING_INVALID');
    await asUser(1); expect((await claim()).rows).toHaveLength(1);
  });
  it('rejects a prekey id conflict instead of falsely acknowledging publication',async () => {
    await publish();
    await db.exec('RESET ROLE; UPDATE device_libsignal_prekey_bundles SET signed_prekey_id=999');
    await asUser(); await expect(publish()).rejects.toThrow('PREKEY_ID_CONFLICT');
  });
  it('does not consume a proof signed by a different device key',async () => {
    await publish();
    await db.exec("RESET ROLE; UPDATE user_devices SET device_signing_key=repeat('B',44) WHERE device_id='ios'");
    await asUser();
    expect((await db.query('SELECT get_libsignal_prekey_inventory($1) AS inventory',['ios'])).rows).toEqual([{inventory:{total:1,verified:0}}]);
    await asUser(1); expect((await claim()).rows).toEqual([]);
  });
  it('does not accept half-present proofs even through privileged maintenance',async () => {
    await publish(); await db.exec('RESET ROLE');
    await expect(db.exec('UPDATE device_libsignal_prekey_bundles SET bundle_signature=null')).rejects.toThrow(/constraint/);
    await expect(db.exec('UPDATE device_libsignal_prekey_bundles SET bundle_signing_key=null')).rejects.toThrow(/constraint|BUNDLE_BINDING_INVALID/);
  });
  async function addReceivedCopy() {
    await db.exec(`RESET ROLE; INSERT INTO messages(id,sender_id) VALUES('${uid(20)}','${uid(2)}');
      INSERT INTO message_device_copies VALUES('${uid(20)}','${uid(1)}','${uid(2)}','ios')`);
    await asUser(1);
  }
  const readProof = () => db.query<{proof:Record<string,unknown>}>('SELECT get_libsignal_receive_attestation($1,$2) AS proof',[uid(2),'ios']);
  it('retains the public receive proof after every consumable prekey is claimed',async()=>{
    await publish(); await asUser(1); await claim(); await addReceivedCopy();
    const result = await readProof();
    expect(result.rows[0].proof).toMatchObject({userId:uid(2),deviceId:'ios',deviceNumber:2,registrationId:202,
      signature:proof,publicBundle:bundle,deviceSigningKey:publicKey,accountFingerprint:'fingerprint'});
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT count(*)::integer AS n FROM device_libsignal_prekey_bundles')).rows[0]).toEqual({n:0});
  });
  it('does not give a stranger or a mere conversation participant access to receive proofs',async()=>{
    await publish(); await asUser(1); await expect(readProof()).rejects.toThrow('RECEIVE_PROOF_UNAVAILABLE');
    await asUser(3); await expect(readProof()).rejects.toThrow('RECEIVE_PROOF_UNAVAILABLE');
    await asUser(2); expect((await readProof()).rows).toHaveLength(1);
  });
  it('keeps historical proof after revocation and deletion of the active device registry entry',async()=>{
    await publish(); await addReceivedCopy(); const before=(await readProof()).rows;
    await db.exec("RESET ROLE; UPDATE user_devices SET is_active=false,revoked_at=now() WHERE device_id='ios'");
    await asUser(1); expect((await readProof()).rows).toEqual(before);
    await db.exec("RESET ROLE; DELETE FROM user_devices WHERE device_id='ios'; DELETE FROM user_public_keys");
    await asUser(1); expect((await readProof()).rows).toEqual(before);
  });
  it('refuses unapproved sessions, old clients and direct proof access',async()=>{
    await publish(); await addReceivedCopy();
    await asUser(1,'1',false); await expect(readProof()).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    await asUser(1,'0'); await expect(readProof()).rejects.toThrow('CLIENT_UPDATE_REQUIRED');
    await asUser(1); await expect(db.exec('SELECT * FROM libsignal_receive_attestations')).rejects.toThrow(/permission denied/);
    await expect(db.exec('DELETE FROM libsignal_receive_attestations')).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE; SET ROLE anon'); await expect(readProof()).rejects.toThrow(/permission denied/);
  });
  it('does not authorize a forged copy whose parent message belongs to another sender',async()=>{
    await publish(); await addReceivedCopy();
    await db.exec(`RESET ROLE; UPDATE messages SET sender_id='${uid(3)}'`);
    await asUser(1); await expect(readProof()).rejects.toThrow('RECEIVE_PROOF_UNAVAILABLE');
  });
  it('rejects another valid Libsignal identity under the same device instead of overwriting history',async()=>{
    await publish();
    const packed=await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(202),2,21,22,23);
    const n=new DataView(packed.buffer,packed.byteOffset,4).getUint32(0,true);
    const replacement=Buffer.from(packed.slice(n+8)).toString('base64');
    const ctx={...context(),publicBundle:replacement};
    const signed=await signLibsignalBundleBinding(ctx,key.privateKey);
    expect(await crypto.subtle.verify('Ed25519',key.publicKey,Buffer.from(signed,'base64'),new TextEncoder().encode(libsignalBundleBindingPayload(ctx)))).toBe(true);
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO test_valid_signatures VALUES($1,$2,$3)',[publicKey,signed,new TextEncoder().encode(libsignalBundleBindingPayload(ctx))]);
    await asUser();
    await expect(db.query('SELECT publish_libsignal_prekey_bundle($1,2,202,21,22,23,$2,$3)',['ios',replacement,signed])).rejects.toThrow('IDENTITY_BINDING_INVALID');
    expect((await readProof()).rows[0].proof.publicBundle).toBe(bundle);
  });
});
