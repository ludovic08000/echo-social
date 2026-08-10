import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createClient } from 'npm:@supabase/supabase-js@2.93.2';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{16,1024}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CHALLENGE_TTL_MS = 5 * 60_000;

class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function cors(origin: string | null) {
  const allowed = origin === 'https://forsure.fans'
    || origin === 'https://www.forsure.fans'
    || (!!origin && /^https:\/\/[a-z0-9-]+\.lovable\.app$/i.test(origin));
  return {
    'access-control-allow-origin': allowed && origin ? origin : 'https://forsure.fans',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'vary': 'Origin',
  };
}

function json(origin: string | null, status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status, headers: cors(origin) });
}

function env() {
  const url = Deno.env.get('SUPABASE_URL') || '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !anon || !service) throw new ApiError('WEBAUTHN_SUPABASE_CONFIG_MISSING', 503);
  return { url, anon, service };
}

function bearer(req: Request) {
  const header = req.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) throw new ApiError('NOT_AUTHENTICATED', 401);
  const token = header.slice(7).trim();
  if (!token) throw new ApiError('NOT_AUTHENTICATED', 401);
  return token;
}

function rpContext(req: Request) {
  const origin = req.headers.get('origin') || '';
  if (!origin) throw new ApiError('WEBAUTHN_ORIGIN_REQUIRED', 403);
  let u: URL;
  try { u = new URL(origin); } catch { throw new ApiError('WEBAUTHN_ORIGIN_INVALID', 403); }
  const allowed = u.origin === 'https://forsure.fans'
    || u.origin === 'https://www.forsure.fans'
    || /^https:\/\/[a-z0-9-]+\.lovable\.app$/i.test(u.origin);
  if (!allowed) throw new ApiError('WEBAUTHN_ORIGIN_DENIED', 403);
  return { origin: u.origin, rpId: u.hostname.toLowerCase() };
}

function b64url(value: string, code = 'WEBAUTHN_BASE64URL_INVALID') {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ApiError(code);
  return Buffer.from(value, 'base64url');
}

function hashB64Url(value: Uint8Array | Buffer | string) {
  return createHash('sha256').update(value).digest('base64url');
}

function parseClientData(encoded: string) {
  const raw = b64url(encoded, 'WEBAUTHN_CLIENT_DATA_INVALID');
  let parsed: any;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ApiError('WEBAUTHN_CLIENT_DATA_INVALID'); }
  return { raw, parsed };
}

function parseAuthData(encoded: string, rpId: string) {
  const raw = b64url(encoded, 'WEBAUTHN_AUTHENTICATOR_DATA_INVALID');
  if (raw.length < 37) throw new ApiError('WEBAUTHN_AUTHENTICATOR_DATA_INVALID');
  const expected = createHash('sha256').update(rpId).digest();
  if (!raw.subarray(0, 32).equals(expected)) throw new ApiError('WEBAUTHN_RP_ID_HASH_MISMATCH', 403);
  const flags = raw[32];
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new ApiError('WEBAUTHN_USER_VERIFICATION_REQUIRED', 403);
  return { raw, signCount: raw.readUInt32BE(33) };
}

function verifyClientData(data: ReturnType<typeof parseClientData>, type: string, challenge: string, origin: string) {
  if (data.parsed?.type !== type) throw new ApiError('WEBAUTHN_CLIENT_TYPE_MISMATCH');
  if (data.parsed?.challenge !== challenge) throw new ApiError('WEBAUTHN_CHALLENGE_MISMATCH', 403);
  if (data.parsed?.origin !== origin) throw new ApiError('WEBAUTHN_ORIGIN_MISMATCH', 403);
  if (data.parsed?.crossOrigin === true) throw new ApiError('WEBAUTHN_CROSS_ORIGIN_DENIED', 403);
}

function registrationProofPayload(args: any) {
  return JSON.stringify({
    protocol: 'forsure-webauthn-device-registration', version: 1,
    userId: args.userId, deviceId: args.deviceId, challengeId: args.challengeId,
    challenge: args.challenge, credentialId: args.credentialId,
    publicKeySha256: args.publicKeySha256, vaultSha256: args.vaultSha256, rpId: args.rpId,
  });
}

function verifyDeviceProof(keyB64: string, payload: string, signatureB64: string) {
  try {
    const rawKey = Buffer.from(keyB64, 'base64');
    const signature = Buffer.from(signatureB64, 'base64');
    if (rawKey.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]), format: 'der', type: 'spki' });
    return verifySignature(null, Buffer.from(payload), key, signature);
  } catch { return false; }
}

async function readyDevice(admin: any, userId: string, deviceId: string) {
  if (!DEVICE_ID_RE.test(deviceId)) throw new ApiError('DEVICE_INVALID_ID');
  const { data, error } = await admin.from('user_devices')
    .select('device_id,device_signing_key,device_public_key,approval_status,binding_status,lifecycle_status,routing_status,is_active,revoked_at')
    .eq('user_id', userId).eq('device_id', deviceId).maybeSingle();
  if (error) throw new ApiError('WEBAUTHN_DEVICE_LOOKUP_FAILED', 502, error.message);
  if (!data || data.approval_status !== 'approved' || data.binding_status !== 'bound'
    || data.lifecycle_status !== 'ready' || data.routing_status !== 'ready'
    || data.is_active !== true || data.revoked_at) throw new ApiError('DEVICE_NOT_READY', 403);
  return data;
}

async function createChallenge(admin: any, args: any) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = Buffer.from(bytes).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const { data, error } = await admin.from('webauthn_device_challenges').insert({
    user_id: args.userId, device_id: args.deviceId ?? null, purpose: args.purpose,
    challenge, rp_id: args.rpId, origin: args.origin, expires_at: expiresAt,
  }).select('id,challenge,expires_at').single();
  if (error || !data) throw new ApiError('WEBAUTHN_CHALLENGE_CREATE_FAILED', 502, error?.message);
  return data;
}

async function loadChallenge(admin: any, userId: string, id: string, purpose: string) {
  const { data, error } = await admin.from('webauthn_device_challenges').select('*')
    .eq('id', id).eq('user_id', userId).eq('purpose', purpose).maybeSingle();
  if (error) throw new ApiError('WEBAUTHN_CHALLENGE_LOOKUP_FAILED', 502, error.message);
  if (!data) throw new ApiError('WEBAUTHN_CHALLENGE_NOT_FOUND', 404);
  if (data.consumed_at) throw new ApiError('WEBAUTHN_CHALLENGE_USED', 409);
  if (Date.parse(data.expires_at) <= Date.now()) throw new ApiError('WEBAUTHN_CHALLENGE_EXPIRED', 410);
  return data;
}

async function status(admin: any, user: any, rpId: string, body: any) {
  const deviceId = String(body.deviceId || '');
  await readyDevice(admin, user.id, deviceId);
  const { data, error } = await admin.from('webauthn_device_credentials').select('credential_id')
    .eq('user_id', user.id).eq('device_id', deviceId).eq('rp_id', rpId).is('revoked_at', null).limit(1).maybeSingle();
  if (error) throw new ApiError('WEBAUTHN_STATUS_FAILED', 502, error.message);
  return { ok: true, registered: !!data };
}

async function registerOptions(admin: any, user: any, ctx: any, body: any) {
  const deviceId = String(body.deviceId || '');
  await readyDevice(admin, user.id, deviceId);
  const challenge = await createChallenge(admin, { userId: user.id, deviceId, purpose: 'register', ...ctx });
  const { data: existing, error } = await admin.from('webauthn_device_credentials').select('credential_id,transports')
    .eq('user_id', user.id).eq('device_id', deviceId).eq('rp_id', ctx.rpId).is('revoked_at', null);
  if (error) throw new ApiError('WEBAUTHN_CREDENTIAL_LOOKUP_FAILED', 502, error.message);
  return { ok: true, challengeId: challenge.id, challenge: challenge.challenge, rpId: ctx.rpId, origin: ctx.origin,
    publicKey: { challenge: challenge.challenge, rp: { id: ctx.rpId, name: 'ForSure' },
      user: { id: Buffer.from(user.id).toString('base64url'), name: user.email || user.id, displayName: user.email || 'ForSure user' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000, attestation: 'none',
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
      excludeCredentials: (existing || []).map((x: any) => ({ type: 'public-key', id: x.credential_id, transports: Array.isArray(x.transports) ? x.transports : [] })) } };
}

async function registerVerify(admin: any, user: any, ctx: any, body: any) {
  const challengeId = String(body.challengeId || '');
  const deviceId = String(body.deviceId || '');
  const credential = body.credential || {};
  const vault = body.vault || {};
  const ch = await loadChallenge(admin, user.id, challengeId, 'register');
  if (ch.device_id !== deviceId || ch.rp_id !== ctx.rpId || ch.origin !== ctx.origin) throw new ApiError('WEBAUTHN_CHALLENGE_MISMATCH', 403);
  const device = await readyDevice(admin, user.id, deviceId);
  const credentialId = String(credential.id || '');
  if (!CREDENTIAL_ID_RE.test(credentialId) || credential.rawId !== credentialId) throw new ApiError('WEBAUTHN_CREDENTIAL_ID_INVALID');
  const client = parseClientData(String(credential.clientDataJSON || ''));
  verifyClientData(client, 'webauthn.create', ch.challenge, ctx.origin);
  const auth = parseAuthData(String(credential.authenticatorData || ''), ctx.rpId);
  if (Number(credential.publicKeyAlgorithm) !== -7) throw new ApiError('WEBAUTHN_ALGORITHM_UNSUPPORTED');
  const publicKeyDer = b64url(String(credential.publicKey || ''), 'WEBAUTHN_PUBLIC_KEY_INVALID');
  let publicKey: any;
  try { publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' }); } catch { throw new ApiError('WEBAUTHN_PUBLIC_KEY_INVALID'); }
  if (publicKey.asymmetricKeyType !== 'ec') throw new ApiError('WEBAUTHN_ALGORITHM_UNSUPPORTED');
  if (Number(vault.version) !== 1 || typeof vault.iv !== 'string' || typeof vault.ciphertext !== 'string') throw new ApiError('WEBAUTHN_DEVICE_VAULT_INVALID');
  const publicKeySha256 = hashB64Url(publicKeyDer);
  const vaultSha256 = hashB64Url(JSON.stringify({ version: 1, iv: vault.iv, ciphertext: vault.ciphertext }));
  const proofPayload = registrationProofPayload({ userId: user.id, deviceId, challengeId, challenge: ch.challenge,
    credentialId, publicKeySha256, vaultSha256, rpId: ctx.rpId });
  if (!verifyDeviceProof(device.device_signing_key, proofPayload, String(body.deviceProof || ''))) throw new ApiError('WEBAUTHN_DEVICE_PROOF_INVALID', 403);
  const transports = Array.isArray(credential.transports) ? credential.transports.filter((x: any) => typeof x === 'string').slice(0, 8) : [];
  const { data, error } = await admin.rpc('webauthn_finalize_device_registration', {
    p_user_id: user.id, p_device_id: deviceId, p_challenge_id: challengeId, p_credential_id: credentialId,
    p_rp_id: ctx.rpId, p_public_key_spki: credential.publicKey, p_algorithm: -7, p_sign_count: auth.signCount,
    p_transports: transports, p_vault_version: 1, p_vault_iv: vault.iv, p_vault_ciphertext: vault.ciphertext,
  });
  if (error) throw new ApiError('WEBAUTHN_REGISTRATION_FINALIZE_FAILED', 502, error.message);
  if (!data?.ok) throw new ApiError(data?.code || 'WEBAUTHN_REGISTRATION_REJECTED', 409);
  return data;
}

async function recoverOptions(admin: any, user: any, ctx: any) {
  const { data: devices, error: de } = await admin.from('user_devices').select('device_id')
    .eq('user_id', user.id).eq('approval_status', 'approved').eq('binding_status', 'bound')
    .eq('lifecycle_status', 'ready').eq('routing_status', 'ready').eq('is_active', true).is('revoked_at', null);
  if (de) throw new ApiError('WEBAUTHN_DEVICE_LOOKUP_FAILED', 502, de.message);
  const ids = (devices || []).map((x: any) => x.device_id);
  if (!ids.length) throw new ApiError('WEBAUTHN_RECOVERY_NOT_CONFIGURED', 404);
  const { data: creds, error } = await admin.from('webauthn_device_credentials')
    .select('credential_id,device_id,transports').eq('user_id', user.id).eq('rp_id', ctx.rpId).in('device_id', ids).is('revoked_at', null);
  if (error) throw new ApiError('WEBAUTHN_CREDENTIAL_LOOKUP_FAILED', 502, error.message);
  if (!creds?.length) throw new ApiError('WEBAUTHN_RECOVERY_NOT_CONFIGURED', 404);
  const ch = await createChallenge(admin, { userId: user.id, purpose: 'recover', ...ctx });
  return { ok: true, challengeId: ch.id, challenge: ch.challenge, rpId: ctx.rpId, origin: ctx.origin,
    publicKey: { challenge: ch.challenge, rpId: ctx.rpId, timeout: 60000, userVerification: 'required',
      allowCredentials: creds.map((x: any) => ({ type: 'public-key', id: x.credential_id, transports: Array.isArray(x.transports) ? x.transports : [] })) } };
}

async function recoverVerify(admin: any, user: any, ctx: any, body: any) {
  const challengeId = String(body.challengeId || '');
  const credential = body.credential || {};
  const ch = await loadChallenge(admin, user.id, challengeId, 'recover');
  if (ch.rp_id !== ctx.rpId || ch.origin !== ctx.origin) throw new ApiError('WEBAUTHN_CHALLENGE_MISMATCH', 403);
  const credentialId = String(credential.id || '');
  if (!CREDENTIAL_ID_RE.test(credentialId) || credential.rawId !== credentialId) throw new ApiError('WEBAUTHN_CREDENTIAL_ID_INVALID');
  const { data: stored, error } = await admin.from('webauthn_device_credentials').select('*')
    .eq('credential_id', credentialId).eq('user_id', user.id).eq('rp_id', ctx.rpId).is('revoked_at', null).maybeSingle();
  if (error) throw new ApiError('WEBAUTHN_CREDENTIAL_LOOKUP_FAILED', 502, error.message);
  if (!stored) throw new ApiError('WEBAUTHN_CREDENTIAL_NOT_FOUND', 404);
  await readyDevice(admin, user.id, stored.device_id);
  const client = parseClientData(String(credential.clientDataJSON || ''));
  verifyClientData(client, 'webauthn.get', ch.challenge, ctx.origin);
  const auth = parseAuthData(String(credential.authenticatorData || ''), ctx.rpId);
  const signature = b64url(String(credential.signature || ''), 'WEBAUTHN_SIGNATURE_INVALID');
  let key: any;
  try { key = createPublicKey({ key: b64url(stored.public_key_spki, 'WEBAUTHN_PUBLIC_KEY_INVALID'), format: 'der', type: 'spki' }); }
  catch { throw new ApiError('WEBAUTHN_PUBLIC_KEY_INVALID'); }
  const clientHash = createHash('sha256').update(client.raw).digest();
  if (!verifySignature('sha256', Buffer.concat([auth.raw, clientHash]), key, signature)) throw new ApiError('WEBAUTHN_ASSERTION_SIGNATURE_INVALID', 403);
  if (stored.sign_count > 0 && auth.signCount > 0 && auth.signCount <= stored.sign_count) throw new ApiError('WEBAUTHN_SIGN_COUNT_REPLAY', 409);
  const { data, error: fe } = await admin.rpc('webauthn_finalize_device_recovery', {
    p_user_id: user.id, p_challenge_id: challengeId, p_credential_id: credentialId, p_new_sign_count: auth.signCount,
  });
  if (fe) throw new ApiError('WEBAUTHN_RECOVERY_FINALIZE_FAILED', 502, fe.message);
  if (!data?.ok) throw new ApiError(data?.code || 'WEBAUTHN_RECOVERY_REJECTED', 409);
  return data;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  try {
    if (req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 405);
    const ctx = rpContext(req);
    const token = bearer(req);
    const cfg = env();
    const authClient = createClient(cfg.url, cfg.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: ud, error: ue } = await authClient.auth.getUser(token);
    if (ue || !ud.user) throw new ApiError('NOT_AUTHENTICATED', 401);
    const admin = createClient(cfg.url, cfg.service, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json().catch(() => { throw new ApiError('INVALID_JSON'); });
    const action = String(body?.action || '');
    let result: any;
    if (action === 'status') result = await status(admin, ud.user, ctx.rpId, body);
    else if (action === 'register-options') result = await registerOptions(admin, ud.user, ctx, body);
    else if (action === 'register-verify') result = await registerVerify(admin, ud.user, ctx, body);
    else if (action === 'recover-options') result = await recoverOptions(admin, ud.user, ctx);
    else if (action === 'recover-verify') result = await recoverVerify(admin, ud.user, ctx, body);
    else throw new ApiError('WEBAUTHN_ACTION_INVALID');
    return json(origin, 200, { data: result, error: null });
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError('WEBAUTHN_SERVER_FAILURE', 500, error instanceof Error ? error.message : 'failure');
    return json(origin, e.status, { data: null, error: { code: e.code, message: e.message } });
  }
});
