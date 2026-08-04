import { once } from 'node:events';
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { createAegisServer } from './server.mjs';

const cryptoApi = webcrypto;
const encoder = new TextEncoder();
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const publishableKey = String(process.env.SUPABASE_ANON_KEY || '');
if (!supabaseUrl || !publishableKey) throw new Error('LIVE_TEST_CONFIGURATION_MISSING');

const runId = randomUUID();
const startedAt = Date.now();
const safeEvents = [];

const hashRef = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const b64 = (value) => Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('base64');
const exact = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

function log(stage, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    run_id: runId,
    elapsed_ms: Date.now() - startedAt,
    stage,
    ...fields,
  };
  safeEvents.push(record);
  console.log(`AEGIS_LIVE_EVENT ${JSON.stringify(record)}`);
}

async function signup(label) {
  const requestId = randomUUID();
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${publishableKey}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify({ data: { aegis_test_run: runId, aegis_test_label: label } }),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token || !payload?.user?.id) {
    throw new Error(`ANONYMOUS_SIGNUP_FAILED:${payload?.code || payload?.error_code || response.status}:${payload?.message || payload?.msg || 'unknown'}`);
  }
  log('anonymous_user_created', {
    label,
    request_id: requestId,
    status: response.status,
    user_ref: hashRef(payload.user.id),
    is_anonymous: payload.user.is_anonymous === true,
  });
  return { id: payload.user.id, token: payload.access_token };
}

async function directRpc(user, name, args, stage) {
  const requestId = randomUUID();
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${user.token}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify(args),
    redirect: 'error',
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  log(stage, {
    rpc: name,
    request_id: requestId,
    status: response.status,
    ok: response.ok,
    error_code: response.ok ? null : payload?.code || `HTTP_${response.status}`,
  });
  if (!response.ok) {
    throw new Error(`${stage.toUpperCase()}_FAILED:${payload?.code || response.status}:${payload?.message || 'unknown'}`);
  }
  return payload;
}

async function rawPublic(key) {
  return b64(await cryptoApi.subtle.exportKey('raw', key));
}

async function buildDeviceAuthorization(userId, deviceId) {
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
  const fpDigest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode(bindingPayload)));
  let fingerprint = '';
  for (let index = 0; index < 20; index += 1) {
    if (index > 0 && index % 4 === 0) fingerprint += ' ';
    fingerprint += fpDigest[index].toString(16).padStart(2, '0');
  }
  fingerprint = fingerprint.toUpperCase();
  const bindingSignature = b64(await cryptoApi.subtle.sign('Ed25519', accountSigning.privateKey, encoder.encode(bindingPayload)));
  const authorizationPayload = JSON.stringify({
    protocol: 'forsure-aegis-device-authorization',
    userId,
    deviceId,
    accountFingerprint: fingerprint,
    devicePublicKey,
    deviceSigningKey,
  });
  const authorizationSignature = b64(await cryptoApi.subtle.sign('Ed25519', accountSigning.privateKey, encoder.encode(authorizationPayload)));
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

async function registerDevice(user, label) {
  const deviceId = `test-${randomUUID()}`;
  const keys = await buildDeviceAuthorization(user.id, deviceId);
  const result = await directRpc(user, 'register_user_device_safe', {
    p_user_id: user.id,
    p_device_id: deviceId,
    p_device_name: `Aegis anonymous test ${label}`,
    p_device_public_key: keys.devicePublicKey,
    p_device_fingerprint: `test-${hashRef(deviceId)}`,
    p_platform: 'github-actions',
    p_user_agent: 'aegis-live-delivery/1',
    p_device_signing_key: keys.deviceSigningKey,
    p_device_authorization_signature: keys.authorizationSignature,
    p_account_identity_key: keys.identityKey,
    p_account_signing_key: keys.signingKey,
    p_account_fingerprint: keys.fingerprint,
    p_account_binding_signature: keys.bindingSignature,
  }, `device_registered_${label}`);
  if (result?.ok !== true) throw new Error(`DEVICE_REGISTRATION_REJECTED:${result?.code || 'UNKNOWN'}`);
  log('device_route_authorized', { label, device_ref: hashRef(deviceId), code: result.code });
  return { deviceId };
}

async function createEncryptedParent(messageId, conversationId, senderId) {
  const keyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const key = await cryptoApi.subtle.importKey('raw', exact(keyBytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const aad = encoder.encode(`FORSURE-AEGIS-MESSAGE-v1|${messageId}|${conversationId}|${senderId}`);
  const plaintext = encoder.encode(`Aegis anonymous delivery test ${runId}`);
  const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  const digest = createHash('sha256').update(Buffer.concat([iv, Buffer.from(ciphertext)])).digest('base64');
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
  const opened = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext);
  if (Buffer.from(opened).compare(Buffer.from(plaintext)) !== 0) throw new Error('PARENT_ENVELOPE_SELF_CHECK_FAILED');
  log('parent_envelope_encrypted', { message_ref: hashRef(messageId), integrity_self_check: true });
  return body;
}

function validRatchetWire() {
  return [
    'aegis1.ratchet',
    `s_${randomBytes(16).toString('base64url')}`,
    randomBytes(32).toString('base64'),
    '0',
    '0',
    randomBytes(12).toString('base64'),
    randomBytes(48).toString('base64'),
  ].join('.');
}

async function gatewayRpc(baseUrl, user, path, args, stage) {
  const requestId = `live-${stage}-${randomUUID()}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${user.token}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify(args),
  });
  const payload = await response.json().catch(() => null);
  const returnedRequestId = response.headers.get('x-request-id') || requestId;
  log(stage, {
    request_id: returnedRequestId,
    status: response.status,
    ok: response.ok,
    error_code: response.ok ? null : payload?.error?.code || `HTTP_${response.status}`,
  });
  if (!response.ok) throw new Error(`${stage.toUpperCase()}_FAILED:${payload?.error?.code || response.status}:${payload?.error?.message || 'unknown'}`);
  return payload?.data;
}

let gateway;
try {
  log('scenario_started', { mode: 'anonymous_transport_delivery' });
  const sender = await signup('sender');
  const recipient = await signup('recipient');
  const senderDevice = await registerDevice(sender, 'sender');
  const recipientDevice = await registerDevice(recipient, 'recipient');

  const conversationId = await directRpc(sender, 'create_or_get_dm_conversation', { p_other_user: recipient.id }, 'conversation_created');
  if (typeof conversationId !== 'string') throw new Error('CONVERSATION_ID_INVALID');
  log('conversation_ready', { conversation_ref: hashRef(conversationId) });

  const routeVersion = await directRpc(sender, 'get_aegis_conversation_route_version', { p_conversation_id: conversationId }, 'route_version_resolved');
  if (typeof routeVersion !== 'string' || routeVersion.length === 0) throw new Error('ROUTE_VERSION_INVALID');

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
  const baseUrl = `http://127.0.0.1:${gateway.address().port}`;
  log('gateway_started', { implementation: 'shared_aegis_core', upstream: 'lovable_cloud_supabase' });

  const messageId = randomUUID();
  const parentBody = await createEncryptedParent(messageId, conversationId, sender.id);
  const copyWire = validRatchetWire();
  const receipt = await gatewayRpc(baseUrl, sender, '/v1/rpc/aegis_send_message', {
    p_message_id: messageId,
    p_conversation_id: conversationId,
    p_body: parentBody,
    p_image_url: null,
    p_extra: {},
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
  if (receipt?.state !== 'committed' || receipt?.message_id !== messageId) throw new Error('COMMIT_RECEIPT_INVALID');
  log('commit_receipt_verified', {
    message_ref: hashRef(messageId),
    existing: receipt.existing === true,
    digest_present: /^[a-f0-9]{64}$/i.test(String(receipt.request_digest || '')),
  });

  const synced = await gatewayRpc(baseUrl, recipient, '/v1/rpc/aegis_sync_device', {
    p_device_id: recipientDevice.deviceId,
    p_limit: 25,
  }, 'recipient_sync');
  const rows = Array.isArray(synced) ? synced : [];
  const delivered = rows.find((row) => row?.message_id === messageId);
  if (!delivered) throw new Error('DELIVERY_NOT_VISIBLE_IN_RECIPIENT_SYNC');
  if (delivered.encrypted_body !== copyWire || delivered.parent_body !== parentBody) throw new Error('DELIVERED_PAYLOAD_MISMATCH');
  log('message_delivered', {
    message_ref: hashRef(messageId),
    recipient_device_ref: hashRef(recipientDevice.deviceId),
    sync_batch_count: rows.length,
    encrypted_parent_match: true,
    encrypted_copy_match: true,
  });

  const ackCount = await gatewayRpc(baseUrl, recipient, '/v1/rpc/aegis_ack_device_messages', {
    p_device_id: recipientDevice.deviceId,
    p_message_ids: [messageId],
    p_mark_read: true,
  }, 'recipient_ack');
  if (ackCount !== 1) throw new Error(`ACK_COUNT_INVALID:${ackCount}`);
  log('ack_confirmed', { message_ref: hashRef(messageId), ack_count: ackCount });

  const afterAck = await gatewayRpc(baseUrl, recipient, '/v1/rpc/aegis_sync_device', {
    p_device_id: recipientDevice.deviceId,
    p_limit: 25,
  }, 'recipient_resync_after_ack');
  const stillPending = Array.isArray(afterAck) && afterAck.some((row) => row?.message_id === messageId);
  if (stillPending) throw new Error('ACK_DID_NOT_REMOVE_PENDING_DELIVERY');
  log('delivery_lifecycle_complete', {
    message_ref: hashRef(messageId),
    pending_after_ack: false,
    gateway_log_count: gatewayLogs.length,
  });

  console.log(`AEGIS_LIVE_RESULT ${JSON.stringify({
    ok: true,
    run_id: runId,
    message_ref: hashRef(messageId),
    sender_user_ref: hashRef(sender.id),
    recipient_user_ref: hashRef(recipient.id),
    gateway_log_count: gatewayLogs.length,
    event_count: safeEvents.length,
    duration_ms: Date.now() - startedAt,
  })}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log('scenario_failed', { code: message.split(':')[0] });
  console.error(`AEGIS_LIVE_RESULT ${JSON.stringify({ ok: false, run_id: runId, code: message, duration_ms: Date.now() - startedAt })}`);
  process.exitCode = 1;
} finally {
  if (gateway) {
    gateway.close();
    await once(gateway, 'close').catch(() => undefined);
  }
}
