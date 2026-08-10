import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 30 };

const CHALLENGE_TTL_MS = 5 * 60_000;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{16,1024}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

class ApiError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function envConfig() {
  const supabaseUrl = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(
    process.env.SUPABASE_ANON_KEY
      || process.env.SUPABASE_PUBLISHABLE_KEY
      || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
      || '',
  ).trim();
  const serverKey = String(
    process.env.SUPABASE_SECRET_TOKEN
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '',
  ).trim();
  if (!supabaseUrl || !anonKey) throw new ApiError('WEBAUTHN_SUPABASE_CONFIG_MISSING', 503);
  if (!serverKey) throw new ApiError('WEBAUTHN_SERVER_SECRET_MISSING', 503);
  return { supabaseUrl, anonKey, serverKey };
}

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify(payload));
}

function parseBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string' && request.body.length > 0) {
    try { return JSON.parse(request.body); } catch { throw new ApiError('INVALID_JSON'); }
  }
  return {};
}

function bearerToken(request) {
  const header = String(request.headers?.authorization || '');
  if (!header.startsWith('Bearer ')) throw new ApiError('NOT_AUTHENTICATED', 401);
  const token = header.slice(7).trim();
  if (!token || /\s/.test(token)) throw new ApiError('NOT_AUTHENTICATED', 401);
  return token;
}

function requestRpContext(request) {
  const origin = String(request.headers?.origin || '').trim();
  if (!origin) throw new ApiError('WEBAUTHN_ORIGIN_REQUIRED', 403);
  let url;
  try { url = new URL(origin); } catch { throw new ApiError('WEBAUTHN_ORIGIN_INVALID', 403); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new ApiError('WEBAUTHN_SECURE_ORIGIN_REQUIRED', 403);
  }
  const hostHeader = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '').toLowerCase();
  if (hostHeader && url.host.toLowerCase() !== hostHeader) throw new ApiError('WEBAUTHN_HOST_ORIGIN_MISMATCH', 403);
  return { origin: url.origin, rpId: url.hostname.toLowerCase() };
}

function toB64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function fromB64Url(value, code = 'WEBAUTHN_BASE64URL_INVALID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ApiError(code);
  try { return Buffer.from(value, 'base64url'); } catch { throw new ApiError(code); }
}

function sha256B64Url(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function parseClientData(encoded) {
  const raw = fromB64Url(encoded, 'WEBAUTHN_CLIENT_DATA_INVALID');
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ApiError('WEBAUTHN_CLIENT_DATA_INVALID'); }
  if (!parsed || typeof parsed !== 'object') throw new ApiError('WEBAUTHN_CLIENT_DATA_INVALID');
  return { raw, parsed };
}

function parseAuthenticatorData(encoded, rpId) {
  const raw = fromB64Url(encoded, 'WEBAUTHN_AUTHENTICATOR_DATA_INVALID');
  if (raw.length < 37) throw new ApiError('WEBAUTHN_AUTHENTICATOR_DATA_INVALID');
  const expectedRpHash = createHash('sha256').update(rpId, 'utf8').digest();
  if (!raw.subarray(0, 32).equals(expectedRpHash)) throw new ApiError('WEBAUTHN_RP_ID_HASH_MISMATCH', 403);
  const flags = raw[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  if (!userPresent || !userVerified) throw new ApiError('WEBAUTHN_USER_VERIFICATION_REQUIRED', 403);
  const signCount = raw.readUInt32BE(33);
  return { raw, signCount };
}

function requireClientCeremony(clientData, { type, challenge, origin }) {
  if (clientData.parsed.type !== type) throw new ApiError('WEBAUTHN_CLIENT_TYPE_MISMATCH');
  if (clientData.parsed.challenge !== challenge) throw new ApiError('WEBAUTHN_CHALLENGE_MISMATCH', 403);
  if (clientData.parsed.origin !== origin) throw new ApiError('WEBAUTHN_ORIGIN_MISMATCH', 403);
  if (clientData.parsed.crossOrigin === true) throw new ApiError('WEBAUTHN_CROSS_ORIGIN_DENIED', 403);
}

function registrationProofPayload(args) {
  return JSON.stringify({
    protocol: 'forsure-webauthn-device-registration',
    version: 1,
    userId: args.userId,
    deviceId: args.deviceId,
    challengeId: args.challengeId,
    challenge: args.challenge,
    credentialId: args.credentialId,
    publicKeySha256: args.publicKeySha256,
    vaultSha256: args.vaultSha256,
    rpId: args.rpId,
  });
}

function verifyDeviceRegistrationProof(deviceSigningKeyB64, payload, signatureB64) {
  if (typeof deviceSigningKeyB64 !== 'string' || typeof signatureB64 !== 'string') return false;
  let rawKey;
  let signature;
  try {
    rawKey = Buffer.from(deviceSigningKeyB64, 'base64');
    signature = Buffer.from(signatureB64, 'base64');
  } catch {
    return false;
  }
  if (rawKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(null, Buffer.from(payload, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

async function authenticatedUser(token, supabaseUrl, anonKey) {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user?.id) throw new ApiError('NOT_AUTHENTICATED', 401);
  return data.user;
}

function serviceClient(supabaseUrl, serverKey) {
  return createClient(supabaseUrl, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function readyDevice(admin, userId, deviceId) {
  if (!DEVICE_ID_RE.test(String(deviceId || ''))) throw new ApiError('DEVICE_INVALID_ID');
  const { data, error } = await admin
    .from('user_devices')
    .select('device_id,device_signing_key,approval_status,binding_status,lifecycle_status,routing_status,is_active,revoked_at')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) throw new ApiError('WEBAUTHN_DEVICE_LOOKUP_FAILED', 502, error.message);
  if (!data
    || data.approval_status !== 'approved'
    || data.binding_status !== 'bound'
    || data.lifecycle_status !== 'ready'
    || data.routing_status !== 'ready'
    || data.is_active !== true
    || data.revoked_at) {
    throw new ApiError('DEVICE_NOT_READY', 403);
  }
  return data;
}

async function createChallenge(admin, { userId, deviceId = null, purpose, rpId, origin }) {
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const { data, error } = await admin
    .from('webauthn_device_challenges')
    .insert({
      user_id: userId,
      device_id: deviceId,
      purpose,
      challenge,
      rp_id: rpId,
      origin,
      expires_at: expiresAt,
    })
    .select('id,challenge,expires_at')
    .single();
  if (error || !data) throw new ApiError('WEBAUTHN_CHALLENGE_CREATE_FAILED', 502, error?.message);
  return data;
}

async function loadChallenge(admin, userId, challengeId, purpose) {
  const { data, error } = await admin
    .from('webauthn_device_challenges')
    .select('*')
    .eq('id', challengeId)
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .maybeSingle();
  if (error) throw new ApiError('WEBAUTHN_CHALLENGE_LOOKUP_FAILED', 502, error.message);
  if (!data) throw new ApiError('WEBAUTHN_CHALLENGE_NOT_FOUND', 404);
  if (data.consumed_at) throw new ApiError('WEBAUTHN_CHALLENGE_USED', 409);
  if (new Date(data.expires_at).getTime() <= Date.now()) throw new ApiError('WEBAUTHN_CHALLENGE_EXPIRED', 410);
  return data;
}

async function handleStatus(admin, user, rpId, body) {
  const deviceId = String(body.deviceId || '');
  await readyDevice(admin, user.id, deviceId);
  const { data, error } = await admin
    .from('webauthn_device_credentials')
    .select('credential_id,created_at,last_used_at')
    .eq('user_id', user.id)
    .eq('device_id', deviceId)
    .eq('rp_id', rpId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ApiError('WEBAUTHN_STATUS_FAILED', 502, error.message);
  return { ok: true, registered: Boolean(data), credential: data ?? null };
}

async function handleRegisterOptions(admin, user, context, body) {
  const deviceId = String(body.deviceId || '');
  await readyDevice(admin, user.id, deviceId);
  const challenge = await createChallenge(admin, {
    userId: user.id,
    deviceId,
    purpose: 'register',
    rpId: context.rpId,
    origin: context.origin,
  });
  const { data: existing, error } = await admin
    .from('webauthn_device_credentials')
    .select('credential_id,transports')
    .eq('user_id', user.id)
    .eq('device_id', deviceId)
    .eq('rp_id', context.rpId)
    .is('revoked_at', null);
  if (error) throw new ApiError('WEBAUTHN_CREDENTIAL_LOOKUP_FAILED', 502, error.message);
  return {
    ok: true,
    challengeId: challenge.id,
    challenge: challenge.challenge,
    rpId: context.rpId,
    origin: context.origin,
    publicKey: {
      challenge: challenge.challenge,
      rp: { id: context.rpId, name: 'ForSure' },
      user: {
        id: Buffer.from(user.id, 'utf8').toString('base64url'),
        name: user.email || user.id,
        displayName: user.email || 'ForSure user',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60_000,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        requireResidentKey: false,
        userVerification: 'required',
      },
      excludeCredentials: (existing || []).map((item) => ({
        type: 'public-key',
        id: item.credential_id,
        transports: Array.isArray(item.transports) ? item.transports : [],
      })),
    },
  };
}

async function handleRegisterVerify(admin, user, context, body) {
  const challengeId = String(body.challengeId || '');
  const deviceId = String(body.deviceId || '');
  const credential = body.credential || {};
  const vault = body.vault || {};
  const challenge = await loadChallenge(admin, user.id, challengeId, 'register');
  if (challenge.device_id !== deviceId || challenge.rp_id !== context.rpId || challenge.origin !== context.origin) {
    throw new ApiError('WEBAUTHN_CHALLENGE_MISMATCH', 403);
  }
  const device = await readyDevice(admin, user.id, deviceId);
  const credentialId = String(credential.id || '');
  if (!CREDENTIAL_ID_RE.test(credentialId) || credential.rawId !== credentialId) throw new ApiError('WEBAUTHN_CREDENTIAL_ID_INVALID');
  const clientData = parseClientData(credential.clientDataJSON);
  requireClientCeremony(clientData, {
    type: 'webauthn.create',
    challenge: challenge.challenge,
    origin: context.origin,
  });
  const authData = parseAuthenticatorData(credential.authenticatorData, context.rpId);
  if (Number(credential.publicKeyAlgorithm) !== -7) throw new ApiError('WEBAUTHN_ALGORITHM_UNSUPPORTED');
  const publicKeyDer = fromB64Url(credential.publicKey, 'WEBAUTHN_PUBLIC_KEY_INVALID');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  } catch {
    throw new ApiError('WEBAUTHN_PUBLIC_KEY_INVALID');
  }
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new ApiError('WEBAUTHN_ALGORITHM_UNSUPPORTED');
  }
  if (Number(vault.version) !== 1
    || typeof vault.iv !== 'string'
    || !/^[A-Za-z0-9_-]{16,64}$/.test(vault.iv)
    || typeof vault.ciphertext !== 'string'
    || vault.ciphertext.length < 64
    || vault.ciphertext.length > 65_536) {
    throw new ApiError('WEBAUTHN_DEVICE_VAULT_INVALID');
  }
  const publicKeySha256 = sha256B64Url(publicKeyDer);
  const vaultSha256 = sha256B64Url(Buffer.from(JSON.stringify({
    version: 1,
    iv: vault.iv,
    ciphertext: vault.ciphertext,
  }), 'utf8'));
  const proofPayload = registrationProofPayload({
    userId: user.id,
    deviceId,
    challengeId,
    challenge: challenge.challenge,
    credentialId,
    publicKeySha256,
    vaultSha256,
    rpId: context.rpId,
  });
  if (!verifyDeviceRegistrationProof(device.device_signing_key, proofPayload, body.deviceProof)) {
    throw new ApiError('WEBAUTHN_DEVICE_PROOF_INVALID', 403);
  }

  const transports = Array.isArray(credential.transports)
    ? credential.transports.filter((value) => typeof value === 'string').slice(0, 8)
    : [];
  const { data, error } = await admin.rpc('webauthn_finalize_device_registration', {
    p_user_id: user.id,
    p_device_id: deviceId,
    p_challenge_id: challengeId,
    p_credential_id: credentialId,
    p_rp_id: context.rpId,
    p_public_key_spki: credential.publicKey,
    p_algorithm: -7,
    p_sign_count: authData.signCount,
    p_transports: transports,
    p_vault_version: 1,
    p_vault_iv: vault.iv,
    p_vault_ciphertext: vault.ciphertext,
  });
  if (error) throw new ApiError('WEBAUTHN_REGISTRATION_FINALIZE_FAILED', 502, error.message);
  if (!data?.ok) throw new ApiError(data?.code || 'WEBAUTHN_REGISTRATION_REJECTED', 409);
  return data;
}

async function activeRecoveryCredentials(admin, userId, rpId) {
  const { data: devices, error: deviceError } = await admin
    .from('user_devices')
    .select('device_id')
    .eq('user_id', userId)
    .eq('approval_status', 'approved')
    .eq('binding_status', 'bound')
    .eq('lifecycle_status', 'ready')
    .eq('routing_status', 'ready')
    .eq('is_active', true)
    .is('revoked_at', null);
  if (deviceError) throw new ApiError('WEBAUTHN_DEVICE_LOOKUP_FAILED', 502, deviceError.message);
  const ids = (devices || []).map((row) => row.device_id);
  if (ids.length === 0) return [];
  const { data, error } = await admin
    .from('webauthn_device_credentials')
    .select('credential_id,device_id,public_key_spki,algorithm,sign_count,transports')
    .eq('user_id', userId)
    .eq('rp_id', rpId)
    .in('device_id', ids)
    .is('revoked_at', null);
  if (error) throw new ApiError('WEBAUTHN_CREDENTIAL_LOOKUP_FAILED', 502, error.message);
  return data || [];
}

async function handleRecoverOptions(admin, user, context) {
  const credentials = await activeRecoveryCredentials(admin, user.id, context.rpId);
  if (credentials.length === 0) throw new ApiError('WEBAUTHN_RECOVERY_NOT_CONFIGURED', 404);
  const challenge = await createChallenge(admin, {
    userId: user.id,
    purpose: 'recover',
    rpId: context.rpId,
    origin: context.origin,
  });
  return {
    ok: true,
    challengeId: challenge.id,
    challenge: challenge.challenge,
    rpId: context.rpId,
    origin: context.origin,
    publicKey: {
      challenge: challenge.challenge,
      rpId: context.rpId,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: credentials.map((item) => ({
        type: 'public-key',
        id: item.credential_id,
        transports: Array.isArray(item.transports) ? item.transports : [],
      })),
    },
  };
}

async function handleRecoverVerify(admin, user, context, body) {
  const challengeId = String(body.challengeId || '');
  const credential = body.credential || {};
  const challenge = await loadChallenge(admin, user.id, challengeId, 'recover');
  if (challenge.rp_id !== context.rpId || challenge.origin !== context.origin) {
    throw new ApiError('WEBAUTHN_CHALLENGE_MISMATCH', 403);
  }
  const credentialId = String(credential.id || '');
  if (!CREDENTIAL_ID_RE.test(credentialId) || credential.rawId !== credentialId) throw new ApiError('WEBAUTHN_CREDENTIAL_ID_INVALID');
  const { data: stored, error } = await admin
    .from('webauthn_device_credentials')
    .select('*')
    .eq('credential_id', credentialId)
    .eq('user_id', user.id)
    .eq('rp_id', context.rpId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new ApiError('WEBAUTHN_CREDENTIAL_LOOKUP_FAILED', 502, error.message);
  if (!stored) throw new ApiError('WEBAUTHN_CREDENTIAL_NOT_FOUND', 404);
  await readyDevice(admin, user.id, stored.device_id);

  const clientData = parseClientData(credential.clientDataJSON);
  requireClientCeremony(clientData, {
    type: 'webauthn.get',
    challenge: challenge.challenge,
    origin: context.origin,
  });
  const authData = parseAuthenticatorData(credential.authenticatorData, context.rpId);
  const signature = fromB64Url(credential.signature, 'WEBAUTHN_SIGNATURE_INVALID');
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: fromB64Url(stored.public_key_spki, 'WEBAUTHN_PUBLIC_KEY_INVALID'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new ApiError('WEBAUTHN_PUBLIC_KEY_INVALID');
  }
  const clientHash = createHash('sha256').update(clientData.raw).digest();
  const signedData = Buffer.concat([authData.raw, clientHash]);
  if (!verifySignature('sha256', signedData, publicKey, signature)) {
    throw new ApiError('WEBAUTHN_ASSERTION_SIGNATURE_INVALID', 403);
  }
  if (stored.sign_count > 0 && authData.signCount > 0 && authData.signCount <= stored.sign_count) {
    throw new ApiError('WEBAUTHN_SIGN_COUNT_REPLAY', 409);
  }
  const { data, error: finalizeError } = await admin.rpc('webauthn_finalize_device_recovery', {
    p_user_id: user.id,
    p_challenge_id: challengeId,
    p_credential_id: credentialId,
    p_new_sign_count: authData.signCount,
  });
  if (finalizeError) throw new ApiError('WEBAUTHN_RECOVERY_FINALIZE_FAILED', 502, finalizeError.message);
  if (!data?.ok) throw new ApiError(data?.code || 'WEBAUTHN_RECOVERY_REJECTED', 409);
  return data;
}

export default async function handler(request, response) {
  try {
    if (request.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 405);
    const context = requestRpContext(request);
    const token = bearerToken(request);
    const { supabaseUrl, anonKey, serverKey } = envConfig();
    const user = await authenticatedUser(token, supabaseUrl, anonKey);
    const admin = serviceClient(supabaseUrl, serverKey);
    const body = parseBody(request);
    const action = String(body.action || '');

    let result;
    if (action === 'status') result = await handleStatus(admin, user, context.rpId, body);
    else if (action === 'register-options') result = await handleRegisterOptions(admin, user, context, body);
    else if (action === 'register-verify') result = await handleRegisterVerify(admin, user, context, body);
    else if (action === 'recover-options') result = await handleRecoverOptions(admin, user, context);
    else if (action === 'recover-verify') result = await handleRecoverVerify(admin, user, context, body);
    else throw new ApiError('WEBAUTHN_ACTION_INVALID');

    json(response, 200, { data: result, error: null });
  } catch (error) {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError('WEBAUTHN_SERVER_FAILURE', 500, error instanceof Error ? error.message : 'Unexpected WebAuthn failure');
    json(response, apiError.status, {
      data: null,
      error: { code: apiError.code, message: apiError.message },
    });
  }
}
