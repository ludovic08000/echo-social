// @ts-nocheck
/**
 * Disposable live cryptographic delivery test.
 *
 * Two anonymous users, two devices each. The database and durable Aegis RPCs
 * are real; every device copy is produced and opened by the production
 * device-pair Double Ratchet engine. Logs contain only hashes, booleans,
 * status codes and request ids — never JWTs, private keys or ciphertexts.
 */
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAegisServer } from '../../../../infra/aegis-server/server.mjs';
import {
  AEGIS_RATCHET_PREFIX,
  clearAllDeviceSessions,
  establishDeviceSession,
  ratchetDecrypt,
  ratchetEncrypt,
} from '../deviceRatchet';

const LIVE = process.env.AEGIS_LIVE_FOUR_DEVICE_RATCHET === '1';
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const publishableKey = String(process.env.SUPABASE_ANON_KEY || '');
const encoder = new TextEncoder();

const hashRef = (value: unknown) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const b64 = (value: ArrayBuffer | ArrayBufferView) => {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(bytes).toString('base64');
};
const exact = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

interface LiveUser {
  id: string;
  token: string;
  label: string;
}

interface AccountMaterial {
  identityPublicB64: string;
  signingPublicB64: string;
  signingPrivateKey: CryptoKey;
  fingerprint: string;
  bindingSignature: string;
}

interface LiveDevice {
  user: LiveUser;
  id: string;
  label: string;
  accountIdentityB64: string;
}

interface SyncRow {
  message_id: string;
  encrypted_body: string;
  parent_body: string;
}

function safeLog(runId: string, startedAt: number, stage: string, fields: Record<string, unknown> = {}) {
  console.log(`AEGIS_RATCHET_LIVE ${JSON.stringify({
    timestamp: new Date().toISOString(),
    run_id: runId,
    elapsed_ms: Date.now() - startedAt,
    stage,
    ...fields,
  })}`);
}

async function anonymousSignup(runId: string, startedAt: number, label: string): Promise<LiveUser> {
  const requestId = randomUUID();
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${publishableKey}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify({
      data: {
        name: `Aegis Ratchet Test ${label}`,
        aegis_live_ratchet_run: runId,
        aegis_live_ratchet_label: label,
      },
    }),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token || !payload?.user?.id) {
    throw new Error(`ANONYMOUS_SIGNUP_FAILED:${response.status}:${payload?.message || payload?.msg || 'unknown'}`);
  }
  safeLog(runId, startedAt, 'anonymous_user_created', {
    label,
    request_id: requestId,
    status: response.status,
    user_ref: hashRef(payload.user.id),
    is_anonymous: payload.user.is_anonymous === true,
  });
  return { id: payload.user.id, token: payload.access_token, label };
}

async function directRpc(
  runId: string,
  startedAt: number,
  user: LiveUser,
  name: string,
  args: Record<string, unknown>,
  stage: string,
) {
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
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  safeLog(runId, startedAt, stage, {
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

async function rawPublic(key: CryptoKey): Promise<string> {
  return b64(await crypto.subtle.exportKey('raw', key));
}

async function createAccountMaterial(userId: string): Promise<AccountMaterial> {
  const [accountKx, accountSigning] = await Promise.all([
    crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as Promise<CryptoKeyPair>,
    crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>,
  ]);
  const [identityPublicB64, signingPublicB64] = await Promise.all([
    rawPublic(accountKx.publicKey),
    rawPublic(accountSigning.publicKey),
  ]);
  const bindingPayload = JSON.stringify({
    protocol: 'forsure-aegis-account-identity',
    version: 1,
    identityKey: identityPublicB64,
    signingKey: signingPublicB64,
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(bindingPayload)));
  let fingerprint = '';
  for (let index = 0; index < 20; index += 1) {
    if (index > 0 && index % 4 === 0) fingerprint += ' ';
    fingerprint += digest[index].toString(16).padStart(2, '0');
  }
  fingerprint = fingerprint.toUpperCase();
  const bindingSignature = b64(await crypto.subtle.sign(
    'Ed25519',
    accountSigning.privateKey,
    encoder.encode(bindingPayload),
  ));
  return {
    identityPublicB64,
    signingPublicB64,
    signingPrivateKey: accountSigning.privateKey,
    fingerprint,
    bindingSignature,
  };
}

async function registerDevice(
  runId: string,
  startedAt: number,
  user: LiveUser,
  account: AccountMaterial,
  label: string,
): Promise<LiveDevice> {
  const id = `live-${label.toLowerCase()}-${randomUUID()}`;
  const [deviceKx, deviceSigning] = await Promise.all([
    crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as Promise<CryptoKeyPair>,
    crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>,
  ]);
  const [devicePublicKey, deviceSigningKey] = await Promise.all([
    rawPublic(deviceKx.publicKey),
    rawPublic(deviceSigning.publicKey),
  ]);
  const authorizationPayload = JSON.stringify({
    protocol: 'forsure-aegis-device-authorization',
    userId: user.id,
    deviceId: id,
    accountFingerprint: account.fingerprint,
    devicePublicKey,
    deviceSigningKey,
  });
  const authorizationSignature = b64(await crypto.subtle.sign(
    'Ed25519',
    account.signingPrivateKey,
    encoder.encode(authorizationPayload),
  ));
  const result = await directRpc(runId, startedAt, user, 'register_user_device_safe', {
    p_user_id: user.id,
    p_device_id: id,
    p_device_name: `Aegis live ${label}`,
    p_device_public_key: devicePublicKey,
    p_device_fingerprint: `live-${hashRef(id)}`,
    p_platform: 'github-actions',
    p_user_agent: 'aegis-live-four-device-ratchet/1',
    p_device_signing_key: deviceSigningKey,
    p_device_authorization_signature: authorizationSignature,
    p_account_identity_key: account.identityPublicB64,
    p_account_signing_key: account.signingPublicB64,
    p_account_fingerprint: account.fingerprint,
    p_account_binding_signature: account.bindingSignature,
  }, `device_registered_${label}`);
  if (result?.ok !== true) throw new Error(`DEVICE_REGISTRATION_REJECTED:${label}:${result?.code || 'UNKNOWN'}`);
  safeLog(runId, startedAt, 'device_route_authorized', {
    label,
    user_ref: hashRef(user.id),
    device_ref: hashRef(id),
    code: result.code,
  });
  return { user, id, label, accountIdentityB64: account.identityPublicB64 };
}

async function establishRealX25519RatchetPair(
  runId: string,
  startedAt: number,
  from: LiveDevice,
  to: LiveDevice,
  spkId: number,
) {
  const [bootstrapInitiator, responderPreKey] = await Promise.all([
    crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as Promise<CryptoKeyPair>,
    crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as Promise<CryptoKeyPair>,
  ]);
  const [sharedInitiator, sharedResponder, responderPubB64, responderPrivJwk] = await Promise.all([
    crypto.subtle.deriveBits({ name: 'X25519', public: responderPreKey.publicKey }, bootstrapInitiator.privateKey, 256),
    crypto.subtle.deriveBits({ name: 'X25519', public: bootstrapInitiator.publicKey }, responderPreKey.privateKey, 256),
    rawPublic(responderPreKey.publicKey),
    crypto.subtle.exportKey('jwk', responderPreKey.privateKey),
  ]);
  expect(Buffer.from(sharedInitiator).equals(Buffer.from(sharedResponder))).toBe(true);
  const sessionId = await establishDeviceSession(
    from.user.id,
    from.id,
    to.user.id,
    to.id,
    sharedInitiator,
    undefined,
    {
      isInitiator: true,
      peerInitialDhPubB64: responderPubB64,
      peerSpkId: spkId,
      selfIkPubB64: from.accountIdentityB64,
      peerIkPubB64: to.accountIdentityB64,
    },
  );
  await establishDeviceSession(
    to.user.id,
    to.id,
    from.user.id,
    from.id,
    sharedResponder,
    sessionId,
    {
      isInitiator: false,
      peerSpkId: spkId,
      selfInitialDhPrivJwk: responderPrivJwk,
      selfInitialDhPubB64: responderPubB64,
      selfIkPubB64: to.accountIdentityB64,
      peerIkPubB64: from.accountIdentityB64,
    },
  );
  safeLog(runId, startedAt, 'ratchet_pair_established', {
    from_device_ref: hashRef(from.id),
    to_device_ref: hashRef(to.id),
    session_ref: hashRef(sessionId),
    bootstrap_shared_secret_match: true,
  });
}

async function createParentBody(messageId: string, conversationId: string, senderId: string, runId: string) {
  const keyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey('raw', exact(keyBytes), { name: 'AES-GCM' }, false, ['encrypt']);
  const aad = encoder.encode(`FORSURE-AEGIS-MESSAGE-v1|${messageId}|${conversationId}|${senderId}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    encoder.encode(`Aegis route marker ${runId}`),
  );
  const digest = createHash('sha256').update(Buffer.concat([iv, Buffer.from(ciphertext)])).digest('base64');
  return JSON.stringify({
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
}

async function gatewayRpc(
  runId: string,
  startedAt: number,
  baseUrl: string,
  user: LiveUser,
  path: string,
  args: Record<string, unknown>,
  stage: string,
) {
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
  safeLog(runId, startedAt, stage, {
    request_id: returnedRequestId,
    status: response.status,
    ok: response.ok,
    error_code: response.ok ? null : payload?.error?.code || `HTTP_${response.status}`,
  });
  if (!response.ok) {
    throw new Error(`${stage.toUpperCase()}_FAILED:${payload?.error?.code || response.status}:${payload?.error?.message || 'unknown'}`);
  }
  return payload?.data;
}

async function sendLogicalMessage(
  runId: string,
  startedAt: number,
  baseUrl: string,
  conversationId: string,
  sender: LiveDevice,
  targets: LiveDevice[],
  plaintext: string,
) {
  const routeVersion = await directRpc(
    runId,
    startedAt,
    sender.user,
    'get_aegis_conversation_route_version',
    { p_conversation_id: conversationId },
    `route_version_${sender.label}`,
  );
  const messageId = randomUUID();
  const parentBody = await createParentBody(messageId, conversationId, sender.user.id, runId);
  const copies = [];
  for (const target of targets) {
    const encryptedBody = await ratchetEncrypt(
      sender.user.id,
      sender.id,
      target.user.id,
      target.id,
      plaintext,
    );
    expect(encryptedBody).toBeTruthy();
    expect(encryptedBody!.startsWith(AEGIS_RATCHET_PREFIX)).toBe(true);
    copies.push({
      message_id: messageId,
      recipient_user_id: target.user.id,
      recipient_device_id: target.id,
      sender_user_id: sender.user.id,
      sender_device_id: sender.id,
      encrypted_body: encryptedBody,
    });
  }
  expect(new Set(copies.map((copy) => copy.encrypted_body)).size).toBe(targets.length);
  const receipt = await gatewayRpc(runId, startedAt, baseUrl, sender.user, '/v1/rpc/aegis_send_message', {
    p_message_id: messageId,
    p_conversation_id: conversationId,
    p_body: parentBody,
    p_image_url: null,
    p_extra: { live_ratchet_run: runId },
    p_copies: copies,
    p_sender_device_id: sender.id,
    p_route_version: routeVersion,
  }, `message_committed_${sender.label}`);
  expect(receipt?.state).toBe('committed');
  expect(receipt?.message_id).toBe(messageId);
  safeLog(runId, startedAt, 'logical_message_committed', {
    message_ref: hashRef(messageId),
    sender_device_ref: hashRef(sender.id),
    target_count: targets.length,
    unique_ratchet_envelopes: new Set(copies.map((copy) => copy.encrypted_body)).size,
    plaintext_sha256: createHash('sha256').update(plaintext).digest('hex'),
  });
  return { messageId, parentBody, copies };
}

async function syncDecryptAck(
  runId: string,
  startedAt: number,
  baseUrl: string,
  target: LiveDevice,
  messageId: string,
  expectedPlaintext: string,
) {
  const rows = await gatewayRpc(runId, startedAt, baseUrl, target.user, '/v1/rpc/aegis_sync_device', {
    p_device_id: target.id,
    p_limit: 50,
  }, `sync_${target.label}`) as SyncRow[];
  expect(Array.isArray(rows)).toBe(true);
  const row = rows.find((candidate) => candidate.message_id === messageId);
  expect(row).toBeTruthy();
  const plaintext = await ratchetDecrypt(target.user.id, target.id, row!.encrypted_body);
  expect(plaintext).toBe(expectedPlaintext);
  safeLog(runId, startedAt, 'device_plaintext_verified', {
    message_ref: hashRef(messageId),
    device_ref: hashRef(target.id),
    device_label: target.label,
    plaintext_match: plaintext === expectedPlaintext,
    plaintext_sha256: createHash('sha256').update(String(plaintext)).digest('hex'),
  });
  const ackCount = await gatewayRpc(runId, startedAt, baseUrl, target.user, '/v1/rpc/aegis_ack_device_messages', {
    p_device_id: target.id,
    p_message_ids: [messageId],
    p_mark_read: true,
  }, `ack_${target.label}`);
  expect(ackCount).toBe(1);
  const afterAck = await gatewayRpc(runId, startedAt, baseUrl, target.user, '/v1/rpc/aegis_sync_device', {
    p_device_id: target.id,
    p_limit: 50,
  }, `resync_${target.label}`) as SyncRow[];
  expect(afterAck.some((candidate) => candidate.message_id === messageId)).toBe(false);
  safeLog(runId, startedAt, 'device_delivery_complete', {
    message_ref: hashRef(messageId),
    device_ref: hashRef(target.id),
    ack_count: ackCount,
    pending_after_ack: false,
  });
}

(LIVE ? describe : describe.skip)('Aegis live four-device Double Ratchet delivery', () => {
  it('delivers and decrypts exact plaintext on all sibling devices in both directions', async () => {
    if (!supabaseUrl || !publishableKey) throw new Error('LIVE_CONFIGURATION_MISSING');
    const runId = randomUUID();
    const startedAt = Date.now();
    let gateway: ReturnType<typeof createAegisServer> | undefined;
    safeLog(runId, startedAt, 'scenario_started', {
      users: 2,
      devices: 4,
      transport: 'live_lovable_cloud',
      crypto: 'production_device_double_ratchet',
    });
    await clearAllDeviceSessions();
    try {
      const userA = await anonymousSignup(runId, startedAt, 'A');
      const userB = await anonymousSignup(runId, startedAt, 'B');
      const accountA = await createAccountMaterial(userA.id);
      const accountB = await createAccountMaterial(userB.id);
      const A1 = await registerDevice(runId, startedAt, userA, accountA, 'A1');
      const A2 = await registerDevice(runId, startedAt, userA, accountA, 'A2');
      const B1 = await registerDevice(runId, startedAt, userB, accountB, 'B1');
      const B2 = await registerDevice(runId, startedAt, userB, accountB, 'B2');

      const conversationId = await directRpc(
        runId,
        startedAt,
        userA,
        'create_or_get_dm_conversation',
        { p_other_user: userB.id },
        'conversation_created',
      );
      expect(typeof conversationId).toBe('string');

      await establishRealX25519RatchetPair(runId, startedAt, A1, A2, 101);
      await establishRealX25519RatchetPair(runId, startedAt, A1, B1, 102);
      await establishRealX25519RatchetPair(runId, startedAt, A1, B2, 103);

      const gatewayLogs: any[] = [];
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
        logger: (record: any) => {
          gatewayLogs.push(record);
          console.log(`AEGIS_RATCHET_GATEWAY ${JSON.stringify(record)}`);
        },
      });
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const baseUrl = `http://127.0.0.1:${(gateway.address() as any).port}`;

      const firstPlaintext = 'Message clair A1 vers tous les appareils — Double Ratchet validé.';
      const first = await sendLogicalMessage(
        runId,
        startedAt,
        baseUrl,
        conversationId,
        A1,
        [A2, B1, B2],
        firstPlaintext,
      );

      // Wrong sibling device must not open another device's capsule.
      const b1Copy = first.copies.find((copy) => copy.recipient_device_id === B1.id)!;
      await expect(ratchetDecrypt(userB.id, B2.id, b1Copy.encrypted_body)).resolves.toBeNull();
      safeLog(runId, startedAt, 'cross_device_isolation_verified', {
        source_copy_device_ref: hashRef(B1.id),
        wrong_device_ref: hashRef(B2.id),
        decrypt_result: 'null',
      });

      await syncDecryptAck(runId, startedAt, baseUrl, A2, first.messageId, firstPlaintext);
      await syncDecryptAck(runId, startedAt, baseUrl, B1, first.messageId, firstPlaintext);
      await syncDecryptAck(runId, startedAt, baseUrl, B2, first.messageId, firstPlaintext);

      // B2 has consumed A1's first inbound message, so its reply to A1 exercises
      // the bidirectional DH-ratchet turn. Additional independent pairs cover B1/A2.
      await establishRealX25519RatchetPair(runId, startedAt, B2, B1, 201);
      await establishRealX25519RatchetPair(runId, startedAt, B2, A2, 202);

      const replyPlaintext = 'Réponse claire B2 vers les trois autres appareils — synchronisation confirmée.';
      const reply = await sendLogicalMessage(
        runId,
        startedAt,
        baseUrl,
        conversationId,
        B2,
        [B1, A1, A2],
        replyPlaintext,
      );
      await syncDecryptAck(runId, startedAt, baseUrl, B1, reply.messageId, replyPlaintext);
      await syncDecryptAck(runId, startedAt, baseUrl, A1, reply.messageId, replyPlaintext);
      await syncDecryptAck(runId, startedAt, baseUrl, A2, reply.messageId, replyPlaintext);

      expect(gatewayLogs).toHaveLength(14);
      expect(JSON.stringify(gatewayLogs)).not.toContain(userA.token);
      expect(JSON.stringify(gatewayLogs)).not.toContain(userB.token);
      expect(JSON.stringify(gatewayLogs)).not.toContain(firstPlaintext);
      expect(JSON.stringify(gatewayLogs)).not.toContain(replyPlaintext);
      safeLog(runId, startedAt, 'scenario_complete', {
        ok: true,
        users: 2,
        devices: 4,
        logical_messages: 2,
        successful_plaintext_decryptions: 6,
        successful_acks: 6,
        pending_after_ack: 0,
        gateway_log_count: gatewayLogs.length,
        duration_ms: Date.now() - startedAt,
      });
    } finally {
      if (gateway) {
        gateway.close();
        await once(gateway, 'close').catch(() => undefined);
      }
      await clearAllDeviceSessions();
    }
  }, 120_000);
});
