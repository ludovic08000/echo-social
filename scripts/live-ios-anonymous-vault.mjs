import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';

const crypto = globalThis.crypto ?? webcrypto;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const PUBLISHABLE_KEY = String(process.env.SUPABASE_ANON_KEY || '');
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

if (!SUPABASE_URL || !PUBLISHABLE_KEY) {
  throw new Error('LIVE_CONFIGURATION_MISSING');
}

const runId = randomUUID();
const startedAt = Date.now();
const hashRef = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const b64 = (value) => Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('base64');
const b64url = (value) => Buffer.from(value).toString('base64url');

function log(stage, fields = {}) {
  console.log(`AEGIS_IOS_ANON ${JSON.stringify({
    timestamp: new Date().toISOString(),
    run_id: runId,
    elapsed_ms: Date.now() - startedAt,
    stage,
    ...fields,
  })}`);
}

async function request(path, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: PUBLISHABLE_KEY,
      ...(token ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${PUBLISHABLE_KEY}` }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, data };
}

function requireOk(result, stage) {
  if (!result.response.ok) {
    const code = result.data?.code || result.data?.error_code || `HTTP_${result.response.status}`;
    const message = result.data?.message || result.data?.msg || 'unknown';
    throw new Error(`${stage}:${code}:${message}`);
  }
  return result.data;
}

async function main() {
  log('scenario_started', { platform: 'ios', user: 'anonymous', vault: 'device_encrypted_vaults' });

  const signup = await request('/auth/v1/signup', {
    method: 'POST',
    body: {
      data: {
        name: 'Aegis iOS anonymous vault probe',
        ios_anonymous_vault_probe_run: runId,
      },
    },
  });
  const auth = requireOk(signup, 'ANONYMOUS_SIGNUP_FAILED');
  if (!auth?.access_token || !auth?.user?.id) throw new Error('ANONYMOUS_SIGNUP_INVALID_RESPONSE');
  if (auth.user.is_anonymous !== true) throw new Error('ANONYMOUS_SIGNUP_NOT_ANONYMOUS');
  const token = auth.access_token;
  const userId = auth.user.id;
  log('anonymous_user_created', { user_ref: hashRef(userId), is_anonymous: true });

  const begin = requireOk(await request('/rest/v1/rpc/begin_user_device_enrollment', {
    token,
    method: 'POST',
    body: {
      p_device_name: 'Safari · iPhone anonymous live probe',
      p_platform: 'ios',
      p_user_agent: IOS_UA,
    },
  }), 'DEVICE_ENROLLMENT_BEGIN_FAILED');

  if (begin?.ok !== true || !/^dev_[a-f0-9]{32}$/.test(begin.device_id || '')) {
    throw new Error(`DEVICE_ENROLLMENT_BEGIN_INVALID:${JSON.stringify({ ok: begin?.ok, code: begin?.code })}`);
  }
  const challengeId = begin.challenge_id;
  const deviceId = begin.device_id;
  const nonce = begin.nonce;
  const expiresAt = new Date(begin.expires_at).toISOString();
  log('device_challenge_created', { device_ref: hashRef(deviceId), server_assigned_id: true });

  const signing = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const kx = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const [signingRaw, kxRaw] = await Promise.all([
    crypto.subtle.exportKey('raw', signing.publicKey),
    crypto.subtle.exportKey('raw', kx.publicKey),
  ]);
  const deviceSigningKey = b64(signingRaw);
  const devicePublicKey = b64(kxRaw);
  const nonceHash = createHash('sha256').update(nonce).digest('hex');
  const possessionPayload = JSON.stringify({
    protocol: 'forsure-aegis-device-possession',
    challengeId,
    deviceId,
    nonceHash,
    expiresAt,
    devicePublicKey,
    deviceSigningKey,
  });
  const possessionSignature = b64(await crypto.subtle.sign(
    'Ed25519',
    signing.privateKey,
    new TextEncoder().encode(possessionPayload),
  ));

  const complete = requireOk(await request('/rest/v1/rpc/complete_user_device_enrollment', {
    token,
    method: 'POST',
    body: {
      p_challenge_id: challengeId,
      p_nonce: nonce,
      p_device_public_key: devicePublicKey,
      p_device_signing_key: deviceSigningKey,
      p_device_possession_signature: possessionSignature,
    },
  }), 'DEVICE_ENROLLMENT_COMPLETE_FAILED');
  if (complete?.ok !== true || complete.device_id !== deviceId) {
    throw new Error(`DEVICE_ENROLLMENT_COMPLETE_INVALID:${JSON.stringify({ ok: complete?.ok, code: complete?.code })}`);
  }
  log('device_enrollment_staged', { device_ref: hashRef(deviceId), code: complete.code || null });

  const ownDevice = requireOk(await request(
    `/rest/v1/user_devices?select=device_id,platform,approval_status,is_active,binding_status,revoked_at&user_id=eq.${encodeURIComponent(userId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
    { token },
  ), 'DEVICE_ROW_READ_FAILED');
  if (!Array.isArray(ownDevice) || ownDevice.length !== 1) throw new Error('DEVICE_ROW_NOT_VISIBLE_TO_OWNER');
  if (ownDevice[0].platform !== 'ios') throw new Error(`DEVICE_PLATFORM_MISMATCH:${ownDevice[0].platform}`);
  log('device_row_verified', {
    device_ref: hashRef(deviceId),
    platform: ownDevice[0].platform,
    approval_status: ownDevice[0].approval_status,
    binding_status: ownDevice[0].binding_status,
  });

  const vault = {
    version: 1,
    iv: b64url(randomBytes(12)),
    ciphertext: b64url(randomBytes(96)),
  };
  const inserted = requireOk(await request('/rest/v1/device_encrypted_vaults?on_conflict=user_id,device_id', {
    token,
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: {
      user_id: userId,
      device_id: deviceId,
      platform: 'ios-web',
      vault,
    },
  }), 'IOS_VAULT_UPSERT_FAILED');
  if (!Array.isArray(inserted) || inserted.length !== 1) throw new Error('IOS_VAULT_UPSERT_NO_ROW');
  log('ios_vault_written', { device_ref: hashRef(deviceId), ciphertext_bytes: 96 });

  const readback = requireOk(await request(
    `/rest/v1/device_encrypted_vaults?select=user_id,device_id,platform,vault&user_id=eq.${encodeURIComponent(userId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
    { token },
  ), 'IOS_VAULT_READ_FAILED');
  if (!Array.isArray(readback) || readback.length !== 1) throw new Error('IOS_VAULT_READBACK_MISSING');
  if (readback[0].vault?.ciphertext !== vault.ciphertext || readback[0].vault?.iv !== vault.iv) {
    throw new Error('IOS_VAULT_READBACK_MISMATCH');
  }
  log('ios_vault_readback_ok', { device_ref: hashRef(deviceId), platform: readback[0].platform });

  const foreignUserId = randomUUID();
  const forbidden = await request('/rest/v1/device_encrypted_vaults', {
    token,
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: {
      user_id: foreignUserId,
      device_id: `dev_${randomBytes(16).toString('hex')}`,
      platform: 'ios-web',
      vault,
    },
  });
  if (forbidden.response.ok) throw new Error('IOS_VAULT_RLS_BYPASS_DETECTED');
  log('ios_vault_rls_negative_ok', { status: forbidden.response.status });

  log('scenario_passed', {
    user_ref: hashRef(userId),
    device_ref: hashRef(deviceId),
    anonymous: true,
    ios_platform: true,
    vault_owner_write: true,
    vault_owner_read: true,
    vault_cross_user_denied: true,
  });
}

main().catch((error) => {
  log('scenario_failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
