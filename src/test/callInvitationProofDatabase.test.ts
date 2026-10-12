// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ load: vi.fn(), identity: vi.fn(), pin: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/crypto/deviceIdentity', () => ({ loadDeviceIdentity: vi.fn() }));
vi.mock('@/lib/crypto/deviceKx', () => ({ loadDeviceKxKey: client.load }));
vi.mock('@/lib/crypto/deviceLinkTrust', () => ({ getApprovedDeviceIdentity: client.identity }));
vi.mock('@/lib/crypto/fingerprintTracker', () => ({ assertExactPeerFingerprintTrusted: client.pin }));
vi.mock('@/lib/crypto/canonicalDeviceRegistry', () => ({ fetchVerifiedDeviceList: vi.fn() }));
vi.mock('@/lib/messaging/currentDevice', () => ({}));
import { callInvitationProofPayload, type CallInvitationContext } from '../lib/calls/callInvitationProof';
import { sealCallKeyForDevice, openCallKeyForCurrentDevice } from '../lib/calls/aegisCallProtocol';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context: CallInvitationContext = { callId: uid(10), conversationId: uid(20), callerId: uid(1),
  callType: 'audio', isGroup: false, recipientUserId: uid(2), recipientDeviceId: 'recipient-device' };
const callerDevice = 'caller-device';
let db: PGlite;
let signing: CryptoKeyPair;
let publicKey: string;
let envelope: string;
let payload: string;
let signature: string;
let recipient: CryptoKeyPair;
let mediaKey: string;
const bytes = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64');
const unsigned = () => ['aegis-call-v1', bytes(32), bytes(12), bytes(60), Buffer.from(callerDevice).toString('base64')].join('.');
async function sign(input: CallInvitationContext, body = unsigned()) {
  const signedPayload = callInvitationProofPayload(input, callerDevice, body);
  const proof = Buffer.from(await crypto.subtle.sign('Ed25519', signing.privateKey, new TextEncoder().encode(signedPayload))).toString('base64');
  expect(await crypto.subtle.verify('Ed25519', signing.publicKey, Buffer.from(proof, 'base64'), new TextEncoder().encode(signedPayload))).toBe(true);
  await db.query('INSERT INTO test_valid_signatures VALUES($1,$2,$3)', [publicKey, proof, new TextEncoder().encode(signedPayload)]);
  return { envelope: body + '.' + proof, payload: signedPayload, signature: proof };
}
async function asUser(n: number | null = 1, approved = true, revision = '1') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('test.uid',$1,false),set_config('test.approved',$2,false),set_config('test.revision',$3,false)",
    [n === null ? '' : uid(n), String(approved), revision]);
  await db.exec('SET ROLE authenticated');
}
const invitations = (wire = envelope) => [{ recipient_user_id: uid(2), recipient_device_id: 'recipient-device', encrypted_call_key: wire }];
async function create(wire = envelope, callId = context.callId, entries = invitations(wire)) {
  return db.query<{ result: { ok: boolean; code: string } }>('SELECT aegis_call_create($1,$2,$3,$4,$5,$6) AS result',
    [callId, context.conversationId, context.callType, callerDevice, [uid(2)], JSON.stringify(entries)]);
}
async function counts() {
  await db.exec('RESET ROLE');
  return (await db.query('SELECT (SELECT count(*)::int FROM active_calls) AS calls,(SELECT count(*)::int FROM aegis_call_invitations) AS invitations')).rows[0];
}

describe('signed call invitations through the actual PostgreSQL RPCs', () => {
  beforeAll(async () => {
    signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    publicKey = Buffer.from(await crypto.subtle.exportKey('raw', signing.publicKey)).toString('base64');
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth,public TO anon,authenticated;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
      CREATE TABLE active_calls(id uuid PRIMARY KEY, conversation_id uuid, caller_id uuid, callee_id uuid,
        caller_ids uuid[],is_group boolean,room_id uuid,call_type text,status text,created_at timestamptz DEFAULT now(),
        answered_at timestamptz,ended_at timestamptz);
      ALTER TABLE active_calls ENABLE ROW LEVEL SECURITY;
      CREATE TABLE conversation_participants(conversation_id uuid,user_id uuid);
      CREATE TABLE friendships(requester_id uuid,addressee_id uuid,status text);
      CREATE TABLE user_devices(user_id uuid,device_id text,device_public_key text DEFAULT 'kx',device_signing_key text,
        device_authorization_signature text DEFAULT 'valid',is_active boolean DEFAULT true,revoked_at timestamptz,
        stale_at timestamptz,crypto_invalid_at timestamptz,approval_status text DEFAULT 'approved',binding_status text DEFAULT 'bound',
        routing_status text DEFAULT 'ready',account_bound_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,device_id));
      CREATE TABLE user_public_keys(user_id uuid,identity_key text DEFAULT 'identity',signing_key text DEFAULT 'signing',
        fingerprint text DEFAULT 'fingerprint',identity_binding_signature text DEFAULT 'valid',identity_binding_version integer DEFAULT 1,
        is_active boolean DEFAULT true,created_at timestamptz DEFAULT now());
      CREATE FUNCTION aegis_verify_account_binding(text,text,text,text,integer) RETURNS boolean LANGUAGE sql AS $$ SELECT $4='valid' $$;
      CREATE FUNCTION aegis_verify_device_authorization(uuid,text,text,text,text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT $5='valid' $$;
      CREATE FUNCTION aegis_decode_base64(text) RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN RETURN decode($1,'base64'); EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;
      CREATE FUNCTION assert_current_login_session_approved() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('test.approved',true) IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LOGIN_SECURITY_APPROVAL_REQUIRED'; END IF; END $$;
      CREATE FUNCTION assert_current_messaging_client() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('test.revision',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'AEGIS_CLIENT_UPDATE_REQUIRED'; END IF; END $$;
      CREATE TABLE test_valid_signatures(key text,signature text,payload bytea);
      -- PGlite ne fournit pas pgsodium : les seules preuves admises sont les
      -- triplets validés avec Ed25519 réel ci-dessus. RPC et triggers restent réels.
      CREATE FUNCTION aegis_verify_ed25519(text,text,bytea) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM test_valid_signatures WHERE key=$1 AND signature=$2 AND payload=$3) $$;
    `);
    const original = readFileSync('supabase/migrations/20260730090000_aegis_clean_rebuild.sql', 'utf8');
    await db.exec(original.slice(original.indexOf('-- Stage 5:'), original.indexOf('-- Stage 6:')));
    await db.exec(readFileSync('supabase/migrations/20261012115746_authenticate_call_invitations.sql', 'utf8'));
    recipient = await crypto.subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
    mediaKey = bytes(32);
    const wire = await sealCallKeyForDevice({ ...context, callerDeviceId: callerDevice,
      callKey: mediaKey, callerSigningPrivateKey: signing.privateKey,
      recipientDevicePublicKey: Buffer.from(await crypto.subtle.exportKey('raw', recipient.publicKey)).toString('base64') });
    const proof = await sign(context, wire.split('.').slice(0, 5).join('.'));
    expect(proof.envelope).toBe(wire);
    envelope = proof.envelope; payload = proof.payload; signature = proof.signature;
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    client.load.mockResolvedValue(recipient);
    client.identity.mockResolvedValue({ deviceId: callerDevice, deviceSigningKey: publicKey, accountFingerprint: 'pinned-caller' });
    client.pin.mockResolvedValue(undefined);
    await db.exec(`RESET ROLE; TRUNCATE active_calls,auth.users,user_devices,user_public_keys,conversation_participants,friendships CASCADE;
      INSERT INTO auth.users VALUES('${uid(1)}'),('${uid(2)}'),('${uid(3)}');
      INSERT INTO user_public_keys(user_id) VALUES('${uid(1)}'),('${uid(2)}');
      INSERT INTO conversation_participants VALUES('${uid(20)}','${uid(1)}'),('${uid(20)}','${uid(2)}');`);
    await db.query('INSERT INTO user_devices(user_id,device_id,device_signing_key) VALUES($1,$2,$3),($4,$5,$3)',
      [uid(1), callerDevice, publicKey, uid(2), 'recipient-device']);
    await asUser();
  });
  it('uses exactly the same canonical signed bytes as the client', async () => {
    await db.exec('RESET ROLE');
    const result = await db.query<{ payload: string }>('SELECT aegis_call_invitation_proof_payload($1,$2,$3,$4,$5,$6,$7,$8,$9) AS payload',
      [context.callId, context.conversationId, context.callerId, callerDevice, context.callType, context.isGroup,
        context.recipientUserId, context.recipientDeviceId, envelope.split('.').slice(0, 5).join('.')]);
    expect(result.rows[0].payload).toBe(payload);
  });
  it('creates, reads, accepts and closes a signed call using the existing RPCs', async () => {
    expect((await create()).rows[0].result.ok).toBe(true);
    await asUser(2);
    const result = await db.query<{ invitation: { encrypted_call_key: string } }>('SELECT aegis_call_get_invitation($1,$2) AS invitation', [uid(10), 'recipient-device']);
    expect(result.rows[0].invitation.encrypted_call_key).toBe(envelope);
    // Parcours réel du corps chiffré : client -> RPC/trigger -> lecture RPC -> déchiffrement client.
    await expect(openCallKeyForCurrentDevice({ ...context, envelope: result.rows[0].invitation.encrypted_call_key })).resolves.toBe(mediaKey);
    expect((await db.query<{ result: { ok: boolean } }>('SELECT aegis_call_update_status($1,$2,$3) AS result', [uid(10), 'recipient-device', 'accepted'])).rows[0].result.ok).toBe(true);
    await asUser(1);
    await db.query('SELECT aegis_call_update_status($1,$2,$3)', [uid(10), callerDevice, 'ended']);
    expect(await counts()).toEqual({ calls: 1, invitations: 1 });
    expect((await db.query('SELECT status FROM active_calls')).rows[0]).toEqual({ status: 'ended' });
  });
  it('rejects unsigned old calls atomically', async () => {
    await expect(create(envelope.split('.').slice(0, 4).join('.'))).rejects.toThrow('CALL_CLIENT_UPDATE_REQUIRED');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it('rejects a forged signature even when the client revision is current', async () => {
    await expect(create(envelope.slice(0, -signature.length) + bytes(64))).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it('rejects replay of an invitation under a different call identifier', async () => {
    await expect(create(envelope, uid(11))).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it('rejects a caller-device substitution in the signed envelope', async () => {
    const parts = envelope.split('.');
    parts[4] = Buffer.from('another-device').toString('base64');
    await expect(create(parts.join('.'))).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it.each([1, 2, 3, 5])('rejects a malformed or noncanonical encoding at position %i', async (index) => {
    const parts = envelope.split('.');
    parts[index] += '\n';
    await expect(create(parts.join('.'))).rejects.toThrow('CALL_INVITATION_INVALID');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it('refuses the original signature under a substituted registered signing key', async () => {
    await db.exec('RESET ROLE');
    await db.query('UPDATE user_devices SET device_signing_key=$1 WHERE device_id=$2', [bytes(32), callerDevice]);
    await asUser();
    await expect(create()).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it('refuses an account whose identity binding is invalid', async () => {
    await db.exec("RESET ROLE; UPDATE user_public_keys SET identity_binding_signature='invalid'");
    await asUser();
    await expect(create()).rejects.toThrow('CALL_DEVICE_NOT_AUTHORIZED');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it.each([['conversationId', uid(21)], ['callerId', uid(3)], ['callType', 'video'], ['isGroup', true],
    ['recipientUserId', uid(3)], ['recipientDeviceId', 'another-device']])('rejects a signature for a different %s', async (field, value) => {
      await db.exec('RESET ROLE');
      const proof = await sign({ ...context, [field]: value });
      await asUser();
      await expect(create(proof.envelope)).rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
      expect(await counts()).toEqual({ calls: 0, invitations: 0 });
    });
  it.each(['stale_at=now()', 'crypto_invalid_at=now()', "binding_status='unbound'", 'account_bound_at=null',
    "routing_status='repairing'", "device_authorization_signature='invalid'"])(
    'rejects a caller that the old RPC accepted with %s', async (mutation) => {
      await db.exec(`RESET ROLE; UPDATE user_devices SET ${mutation} WHERE device_id='caller-device'`);
      await asUser();
      await expect(create()).rejects.toThrow('CALL_DEVICE_NOT_AUTHORIZED');
      expect(await counts()).toEqual({ calls: 0, invitations: 0 });
    });
  it('rejects an unapproved login even with a valid device signature', async () => {
    await asUser(1, false);
    await expect(create()).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it('rejects obsolete clients at the server boundary', async () => {
    await asUser(1, true, '');
    await expect(create()).rejects.toThrow('AEGIS_CLIENT_UPDATE_REQUIRED');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it('rolls back every invitation if just one device envelope is invalid', async () => {
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO user_devices(user_id,device_id,device_signing_key) VALUES($1,$2,$3)', [uid(2), 'second-device', publicKey]);
    await asUser();
    await expect(create(envelope, uid(10), [...invitations(), { ...invitations()[0], recipient_device_id: 'second-device' }]))
      .rejects.toThrow('CALL_INVITATION_SIGNATURE_INVALID');
    expect(await counts()).toEqual({ calls: 0, invitations: 0 });
  });
  it('keeps historical call rows and allows their status to close', async () => {
    await db.exec('RESET ROLE');
    await db.query(`INSERT INTO active_calls(id,conversation_id,caller_id,caller_device_id,call_type,is_group,room_name,protocol_version,status)
      VALUES($1,$2,$3,$4,'audio',false,$5,5,'ringing')`, [uid(10), uid(20), uid(1), callerDevice, 'call-' + uid(10)]);
    await asUser();
    await db.query('SELECT aegis_call_update_status($1,$2,$3)', [uid(10), callerDevice, 'cancelled']);
    expect(await counts()).toEqual({ calls: 1, invitations: 0 });
  });
  it('does not permit changing signed call metadata after creation', async () => {
    await create(); await db.exec('RESET ROLE');
    await expect(db.exec("UPDATE active_calls SET call_type='video'")).rejects.toThrow('CALL_INVITATION_INVALID');
    expect((await db.query('SELECT call_type FROM active_calls')).rows[0]).toEqual({ call_type: 'audio' });
  });
  it('keeps table writes and internal helpers inaccessible to ordinary clients', async () => {
    await create();
    await expect(db.exec("UPDATE active_calls SET status='ended'")).rejects.toThrow('permission denied');
    await expect(db.exec("UPDATE aegis_call_invitations SET encrypted_call_key='invalid'")).rejects.toThrow('permission denied');
    expect((await db.query("SELECT has_function_privilege('authenticated','aegis_call_invitation_proof_payload(uuid,uuid,uuid,text,text,boolean,uuid,text,text)','EXECUTE') AS allowed")).rows[0]).toEqual({ allowed: false });
    await asUser(3);
    expect((await db.query('SELECT * FROM aegis_call_invitations')).rows).toEqual([]);
  });
});
