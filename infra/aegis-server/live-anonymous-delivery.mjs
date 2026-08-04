import { once } from 'node:events';
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { createAegisServer } from './server.mjs';

const cryptoApi = webcrypto;
const encoder = new TextEncoder();
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const publishableKey = String(process.env.SUPABASE_ANON_KEY || '');

if (!supabaseUrl || !publishableKey) {
  throw new Error('LIVE_TEST_CONFIGURATION_MISSING');
}

const runId = randomUUID();
const startedAt = Date.now();
const events = [];

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function event(stage, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    run_id: runId,
    elapsed_ms: Date.now() - startedAt,
    stage,
    ...fields,
  };
  events.push(record);
  console.log(`AEGIS_LIVE_EVENT ${JSON.stringify(record)}`);
}

function exactBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function base64(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  return Buffer.from(bytes).toString('base64');
}

async function rawPublic(key) {
  return base64(await cryptoApi.subtle.exportKey('raw', key));
}

async function createIdentity(userId, deviceId) {
  const [accountKx, accountSigning, deviceKx, deviceSigning] = await Promise.all([
    cryptoApi.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']),
    cryptoApi.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']),
    cryptoApi.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']),
    cryptoApi.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']),
  ]);

  const [identityKey, signingKey, devicePublicKey, deviceSigningKey] = await Promise.all([
    rawPublic(accountKx.publicKey),
    rawPublic(accountSigning.publicKey),
    rawPublic(deviceKx.publicKey),
    rawPublic(deviceSigning.publicKey),
  ]);

  const bindingPayload = JSON.stringify({
    protocol: 'forsure-aegis-account-identity',
    version: 1,
    identityKey,
    signingKey,
  });
  const digest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode(bindingPayload)));
  let fingerprint = '';
  for (let index = 0; index < 20; index += 1) {
    if (index > 0 && index % 4 === 0) fingerprint += ' ';
    fingerprint += digest[index].toString(16).padStart(2, '0');
  }
  fingerprint = fingerprint.toUpperCase();

  const bindingSignature = base64(await cryptoApi.subtle.sign(
    'Ed25519',
    accountSigning.privateKey,
    encoder.encode(bindingPayload),
  ));

  const authorizationPayload = JSON.stringify({
    protocol: 'forsure-aegis-device-authorization',
    userId,
    deviceId,
    accountFingerprint: fingerprint,
    devicePublicKey,
    deviceSigningKey,
  });
  const authorizationSignature = base64(await cryptoApi.subtle.sign(
    'Ed25519',
    accountSigning.privateKey,
    encoder.encode(authorizationPayload),
  ));

  return {
    identityKey,
    signingKey,
    fingerprint,
    bindingSignature,
    devicePublicKey,
    deviceSigningKey,
    authorizationSignature,
  };
}

async function anonymousSignup(label) {
  const correlationId = randomUUID();
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${publishableKey}`,
      'content-type': 'application/json',
      'x-request-id': correlationId,
    },
    body: JSON.stringify({ data: { aegis_test_run: runId, aegis_test_label: label } }),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token || !payload?.user?.id) {
    const code = payload?.code || payload?.error_code || `HTTP_${response.status}`;
    throw new Error(`ANONYMOUS_SIGNUP_FAILED:${code}`);
  }
  event('anonymous_user_created', {
    label,
    status: response.status,
    correlation_id: correlationId,
    user_ref: shortHash(payload.user.id),
    is_anonymous: payload.user.is_anonymous === true,
  });
  return { id: payload.user.id, token: payload.access_token };
}

async function rpc(token, name, body, stage) {
  const correlationId = randomUUID();
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-request-id': correlationId,
    },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  event(stage, {
    rpc: name,
    status: response.status,
    correlation_id: correlationId,
    ok: response.ok,
    error_code: response.ok ? null : payload?.code || `HTTP_${response.status}`,
  });
  if (!response.ok) {
    throw new Error(`${stage.toUpperCase()}_FAILED:${payload?.code || response.status}`);
  }
  return payload;
}

async function registerDevice(user, label) {
  const deviceId = `test-${randomUUID()}`;
  const keys = await createIdentity(user.id, deviceId);
  const result = await rpc(user.token, 'register_user_device_safe', {
    p_user_id: user.id,
    p_device_id: deviceId,
    p_device_name: `Aegis anonymous test ${label}`,
    p_device_public_key: keys.devicePublicKey,
    p_device_fingerprint: `test-${shortHash(deviceId)}`,
    p_platform: 'github-actions',
    p_user_agent: 'aegis-live-delivery/1',
    p_device_signing_key: keys.deviceSigningKey,
    p_device_authorization_signature: keys.authorizationSignature,
    p_account_identity_key: keys.identityKey,
    p_account_signing_key: keys.signingKey,
    p_account_fingerprint: keys.fingerprint,
    p_account_binding_signature: keys.bindingSignature,
  }, `device_registered_${label}`);
  if (result?.ok !== true) {
    throw new Error(`DEVICE_REGISTRATION_REJECTED:${result?.code || 'UNKNOWN'}`);
  }
  event('device_route_authorized', {
    label,
    device_ref: shortHash(deviceId),
    code: result.code,
  });
  return { deviceId, keys };
}

async function createEncryptedMessage({ messageId, conversationId, senderId, plaintext }) {
  const keyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const key = await cryptoApi.subtle.importKey('raw', exactBuffer(keyBytes), { name: 'AES-GCM' }, false, ['encrypt']);
  const aad = encoder.encode(`FORSURE-AEGIS-MESSAGE-v1|${messageId}|${conversationId}|${senderId}`);
  const ciphertext = await cryptoApi.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: aad,
    tagLength: 128,
  }, key, encoder.encode(plaintext));
  const combined = Buffer.concat([iv, Buffer.from(ciphertext)]);
  const digest = createHash('sha256').update(combined).digest('base64');
  const body = JSON.stringify({
    protocol: 'forsure-aegis-message',
    version: 1,
    encryptionMode: 'multi_device',
    algorithm: 'AES-256-GCM',
    keyTransport: 'device_ratchet',
    messageId,
    conversationId,
    senderId,
    iv: iv.toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    digest,
    createdAt: Date.now(),
    traceId: runId,
  });
  return { body, contentKey: keyBytes.toString('base64'), digest };
}

function createValidRatchetWire() {
  const sessionId = `s_${randomBytes(16).toString('base64url')}`;
  return [
    'aegis1.ratchet',
    sessionId,
    randomBytes(32).toString('base64'),
    '0',
    '0',
    randomBytes(12).toString('base64'),
    randomBytes(48).toString('base64'),
  ].join('.');
}

async function gatewayCall(baseUrl, token, path, payload, stage) {
  const requestId = `live-${stage}-${randomUUID()}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  event(stage, {
    status: response.status,
    request_id: response.headers.get('x-request-id') || requestId,
    ok: response.ok,
    error_code: response.ok ? null : body?.error?.code || `HTTP_${response.status}`,
  });
  if (!response.ok) throw new Error(`${stage.toUpperCase()}_FAILED:${body?.error?.code || response.status}`);
  return body?.data;
}

let gateway;
try {
  event('scenario_started', { mode: 'anonymous_live_transport' });
  const [sender, recipient] = await Promise.all([
    anonymousSignup('sender'),
    anonymousSignup('recipient'),
  ]);
  const [senderDevice, recipientDevice] = await Promise.all([
    registerDevice(sender, 'sender'),
    registerDevice(recipient, 'recipient'),
  ]);

  const conversationId = await rpc(sender.token, 'create_or_get_dm_conversation', {
    p_other_user: recipient.id,
  }, 'conversation_created');
  if (typeof conversationId !== 'string') throw new Error('CONVERSATION_ID_INVALID');
  event('conversation_ready', { conversation_ref: shortHash(conversationId) });

  const routeVersion = await rpc(sender.token, 'get_aegis_conversation_route_version', {
    p_conversation_id: conversationId,
  }, 'route_version_resolved');
  if (typeof routeVersion !== 'string' || routeVersion.length === 0) {
    throw new Error('ROUTE_VERSION_INVALID');
  }

  const gatewayLogs = [];
  gateway = createAegisServer({
    config: {
      port: 0,
      supabaseUrl,
      supabaseAnonKey: publishableKey,
      allowedOrigins: new Set(),
      allowedHosts: new Set(),
      maxBodyBytes: 1_048_576,
      upstreamTimeoutMs: 20_000,
    },
    logger: (record) => {
      gatewayLogs.push(record);
      console.log(`AEGIS_GATEWAY_LOG ${JSON.stringify(record)}`);
    },
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  event('gateway_started', { transport: 'local_core_live_supabase' });

  const messageId = randomUUID();
  const encrypted = await createEncryptedMessage({
    messageId,
    conversationId,
    senderId: sender.id,
    plaintext: `Aegis anonymous delivery test ${runId}`,
  });
  const copyWire = createValidRatchetWire();

  const receipt = await gatewayCall(baseUrl, sender.token, '/v1/rpc/aegis_send_message', {
    p_message_id: messageId,
    p_conversation_id: conversationId,
    p_body: encrypted.body,
    p_image_url: null,
    p_extra: { test_run: runId },
    p_copies: [{
      message_id: messageId,
      recipient_user_id: recipient.id,
      recipient_device_id: recipientDevice.deviceId,
      sender_user_id: sender.id,
      sender_device_id: senderDevice.deviceId,
      encrypted_body: copyWire,
    }],
    p_sender_device_id: senderDevice.deviceId,
    p_route_version: routeVersion,
  }, 'message_committed');

  if (receipt?.state !== 'committed' || receipt?.message_id !== messageId) {
    throw new Error('COMMIT_RECEIPT_INVALID');
  }
  event('commit_receipt_verified', {
    message_ref: shortHash(messageId),
    existing: receipt.existing === true,
    digest_present: typeof receipt.request_digest === 'string' && receipt.request_digest.length === 64,
  });

  const synced = await gatewayCall(baseUrl, recipient.token, '/v1/rpc/aegis_sync_device', {
    p_device_id: recipientDevice.deviceId,
    p_limit: 25,
  }, 'recipient_sync');
  const rows = Array.isArray(synced) ? synced : [];
  const delivered = rows.find((row) => row?.message_id === messageId);
  if (!delivered) throw new Error('DELIVERY_NOT_VISIBLE_IN_RECIPIENT_SYNC');
  if (delivered.encrypted_body !== copyWire) throw new Error('DELIVERED_COPY_MISMATCH');
  event('message_delivered', {
    message_ref: shortHash(messageId),
    recipient_device_ref: shortHash(recipientDevice.deviceId),
    sync_batch_count: rows.length,
    copy_match: true,
  });

  const ack = await gatewayCall(baseUrl, recipient.token, '/v1/rpc/aegis_ack_device_messages', {
    p_device_id: recipientDevice.deviceId,
    p_message_ids: [messageId],
    p_mark_read: true,
  }, 'recipient_ack');
  event('ack_confirmed', {
    message_ref: shortHash(messageId),
    ack_result_type: ack === null ? 'null' : Array.isArray(ack) ? 'array' : typeof ack,
  });

  const afterAck = await gatewayCall(baseUrl, recipient.token, '/v1/rpc/aegis_sync_device', {
    p_device_id: recipientDevice.deviceId,
    p_limit: 25,
  }, 'recipient_resync_after_ack');
  const pendingAfterAck = Array.isArray(afterAck)
    ? afterAck.some((row) => row?.message_id === messageId)
    : false;
  if (pendingAfterAck) throw new Error('ACK_DID_NOT_REMOVE_PENDING_DELIVERY');
  event('delivery_lifecycle_complete', {
    message_ref: shortHash(messageId),
    pending_after_ack: false,
    gateway_log_count: gatewayLogs.length,
  });

  console.log(`AEGIS_LIVE_RESULT ${JSON.stringify({
    ok: true,
    run_id: runId,
    message_ref: shortHash(messageId),
    sender_user_ref: shortHash(sender.id),
    recipient_user_ref: shortHash(recipient.id),
    gateway_log_count: gatewayLogs.length,
    duration_ms: Date.now() - startedAt,
  })}`);
} catch (error) {
  event('scenario_failed', {
    code: error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN_FAILURE',
  });
  console.error(`AEGIS_LIVE_RESULT ${JSON.stringify({
    ok: false,
    run_id: runId,
    code: error instanceof Error ? error.message : String(error),
    duration_ms: Date.now() - startedAt,
  })}`);
  process.exitCode = 1;
} finally {
  if (gateway) {
    gateway.close();
    await once(gateway, 'close').catch(() => undefined);
  }
}
