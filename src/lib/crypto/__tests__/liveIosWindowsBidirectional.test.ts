// @ts-nocheck
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { supabase } from '@/integrations/supabase/client';
import { prepareDeviceAuthorization } from '../deviceIdentity';
import {
  beginServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollment,
} from '../serverDeviceEnrollment';
import { fetchVerifiedDeviceIdentity } from '../signedDeviceList';
import {
  fetchPrekeyBundleForDevice,
  finalizeDeviceX3DHInitial,
  generateAndUploadDeviceSignedPrekey,
  refillDeviceOneTimePrekeysIfNeeded,
  x3dhInitiate,
  x3dhRespondForDevice,
} from '../x3dh';
import {
  AEGIS_RATCHET_PREFIX,
  clearAllDeviceSessions,
  establishDeviceSession,
  ratchetDecrypt,
  ratchetEncrypt,
} from '../deviceRatchet';
import { establishResponderRatchetFromDeviceX3DH } from '../x3dhRatchetBootstrap';

const LIVE = process.env.AEGIS_LIVE_IOS_WINDOWS === '1';
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const publishableKey = String(process.env.SUPABASE_ANON_KEY || '');
const gatewayUrl = String(process.env.AEGIS_GATEWAY_URL || '').replace(/\/+$/, '');
const gatewayOrigin = String(process.env.AEGIS_GATEWAY_ORIGIN || 'https://forsure.fans');
const encoder = new TextEncoder();

interface LiveUser {
  id: string;
  token: string;
  refreshToken: string;
  label: 'IOS' | 'WINDOWS';
}

interface LiveDevice {
  user: LiveUser;
  id: string;
  label: 'IPHONE' | 'WINDOWS';
  authorization: Awaited<ReturnType<typeof prepareDeviceAuthorization>>;
}

interface SyncRow {
  message_id: string;
  encrypted_body: string;
  parent_body: string;
}

const hashRef = (value: unknown) =>
  createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

const exact = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

function safeLog(
  runId: string,
  startedAt: number,
  stage: string,
  fields: Record<string, unknown> = {},
) {
  console.log(`AEGIS_IOS_WINDOWS ${JSON.stringify({
    timestamp: new Date().toISOString(),
    run_id: runId,
    elapsed_ms: Date.now() - startedAt,
    stage,
    ...fields,
  })}`);
}

async function anonymousSignup(
  runId: string,
  startedAt: number,
  label: 'IOS' | 'WINDOWS',
): Promise<LiveUser> {
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
        name: `Aegis ${label} live probe`,
        aegis_ios_windows_run: runId,
        aegis_ios_windows_label: label,
      },
    }),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token || !payload?.refresh_token || !payload?.user?.id) {
    throw new Error(`ANONYMOUS_SIGNUP_FAILED:${label}:${response.status}:${payload?.message || 'unknown'}`);
  }
  safeLog(runId, startedAt, 'anonymous_user_created', {
    label,
    request_id: requestId,
    status: response.status,
    user_ref: hashRef(payload.user.id),
    is_anonymous: payload.user.is_anonymous === true,
  });
  return {
    id: payload.user.id,
    token: payload.access_token,
    refreshToken: payload.refresh_token,
    label,
  };
}

async function setActiveUser(user: LiveUser): Promise<void> {
  const { data, error } = await supabase.auth.setSession({
    access_token: user.token,
    refresh_token: user.refreshToken,
  });
  if (error || data.session?.user.id !== user.id) {
    throw new Error(`SET_ACTIVE_USER_FAILED:${user.label}:${error?.message || 'session mismatch'}`);
  }
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

async function gatewayRpc(
  runId: string,
  startedAt: number,
  user: LiveUser,
  path: string,
  args: Record<string, unknown>,
  stage: string,
) {
  const requestId = `ios-windows-${stage}-${randomUUID()}`;
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${user.token}`,
      'content-type': 'application/json',
      origin: gatewayOrigin,
      'x-request-id': requestId,
    },
    body: JSON.stringify(args),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => null);
  safeLog(runId, startedAt, stage, {
    request_id: response.headers.get('x-request-id') || requestId,
    status: response.status,
    ok: response.ok,
    error_code: response.ok ? null : payload?.error?.code || `HTTP_${response.status}`,
  });
  if (!response.ok) {
    throw new Error(`${stage.toUpperCase()}_FAILED:${payload?.error?.code || response.status}:${payload?.error?.message || 'unknown'}`);
  }
  return payload?.data;
}

async function enrollDevice(
  runId: string,
  startedAt: number,
  user: LiveUser,
  label: 'IPHONE' | 'WINDOWS',
): Promise<LiveDevice> {
  await setActiveUser(user);
  const isIphone = label === 'IPHONE';
  const challenge = await beginServerAssignedDeviceEnrollment({
    deviceName: isIphone ? 'Safari · iPhone live probe' : 'Chrome · Windows live probe',
    deviceFingerprint: `${label.toLowerCase()}-${hashRef(runId)}`,
    platform: isIphone ? 'ios' : 'web',
    userAgent: isIphone
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  });
  expect(challenge.deviceId).toMatch(/^dev_[a-f0-9]{32}$/);

  const authorization = await prepareDeviceAuthorization(user.id, challenge.deviceId);
  const deviceId = await completeServerAssignedDeviceEnrollment(challenge, authorization);
  expect(deviceId).toBe(challenge.deviceId);

  const spk = await generateAndUploadDeviceSignedPrekey(
    user.id,
    deviceId,
    authorization.deviceSigning.privateKey,
  );
  await refillDeviceOneTimePrekeysIfNeeded(user.id, deviceId);
  const opkCount = Number(await directRpc(
    runId,
    startedAt,
    user,
    'count_device_one_time_prekeys',
    { p_user_id: user.id, p_device_id: deviceId },
    `${label.toLowerCase()}_opk_count`,
  ));
  expect(opkCount).toBe(100);

  const ready = await directRpc(
    runId,
    startedAt,
    user,
    'mark_current_device_route_ready',
    { p_device_id: deviceId },
    `${label.toLowerCase()}_route_ready`,
  );
  expect(ready?.ok).toBe(true);

  const verified = await fetchVerifiedDeviceIdentity(user.id, deviceId);
  expect(verified).toBeTruthy();
  expect(verified!.devicePublicKey).toBe(authorization.deviceKx.publicB64);
  expect(verified!.deviceSigningKey).toBe(authorization.deviceSigning.publicB64);

  safeLog(runId, startedAt, 'device_enrolled', {
    label,
    platform: isIphone ? 'ios' : 'web/windows',
    user_ref: hashRef(user.id),
    device_ref: hashRef(deviceId),
    server_assigned_id: true,
    account_binding_valid: true,
    device_authorization_valid: true,
    active_spks: 1,
    available_opks: opkCount,
    spk_ref: hashRef(spk.spkId),
    routing_status: 'ready',
  });

  return { user, id: deviceId, label, authorization };
}

async function createParentBody(
  messageId: string,
  conversationId: string,
  senderId: string,
  runId: string,
  direction: string,
) {
  const keyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey(
    'raw',
    exact(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const aad = encoder.encode(`FORSURE-AEGIS-MESSAGE-v1|${messageId}|${conversationId}|${senderId}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    encoder.encode(`Aegis parent marker ${direction} ${runId}`),
  );
  const digest = createHash('sha256')
    .update(Buffer.concat([iv, Buffer.from(ciphertext)]))
    .digest('base64');
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

async function sendAndReceive({
  runId,
  startedAt,
  conversationId,
  sender,
  receiver,
  plaintext,
  direction,
}: {
  runId: string;
  startedAt: number;
  conversationId: string;
  sender: LiveDevice;
  receiver: LiveDevice;
  plaintext: string;
  direction: string;
}) {
  await setActiveUser(sender.user);
  const encryptedBody = await ratchetEncrypt(
    sender.user.id,
    sender.id,
    receiver.user.id,
    receiver.id,
    plaintext,
  );
  expect(encryptedBody).toBeTruthy();
  expect(encryptedBody!.startsWith(AEGIS_RATCHET_PREFIX)).toBe(true);

  const messageId = randomUUID();
  const parentBody = await createParentBody(
    messageId,
    conversationId,
    sender.user.id,
    runId,
    direction,
  );
  const routeVersion = await directRpc(
    runId,
    startedAt,
    sender.user,
    'get_aegis_conversation_route_version',
    { p_conversation_id: conversationId },
    `${direction}_route_version`,
  );
  const receipt = await gatewayRpc(
    runId,
    startedAt,
    sender.user,
    '/v1/rpc/aegis_send_message',
    {
      p_message_id: messageId,
      p_conversation_id: conversationId,
      p_body: parentBody,
      p_image_url: null,
      p_extra: { live_ios_windows_run: runId, direction },
      p_copies: [{
        message_id: messageId,
        recipient_user_id: receiver.user.id,
        recipient_device_id: receiver.id,
        sender_user_id: sender.user.id,
        sender_device_id: sender.id,
        encrypted_body: encryptedBody,
      }],
      p_sender_device_id: sender.id,
      p_route_version: routeVersion,
    },
    `${direction}_message_committed`,
  );
  expect(receipt?.state).toBe('committed');
  expect(receipt?.message_id).toBe(messageId);

  await setActiveUser(receiver.user);
  const rows = await gatewayRpc(
    runId,
    startedAt,
    receiver.user,
    '/v1/rpc/aegis_sync_device',
    { p_device_id: receiver.id, p_limit: 50 },
    `${direction}_receiver_sync`,
  ) as SyncRow[];
  const row = rows.find((candidate) => candidate.message_id === messageId);
  expect(row).toBeTruthy();
  const recovered = await ratchetDecrypt(receiver.user.id, receiver.id, row!.encrypted_body);
  expect(recovered).toBe(plaintext);

  const ackCount = await gatewayRpc(
    runId,
    startedAt,
    receiver.user,
    '/v1/rpc/aegis_ack_device_messages',
    {
      p_device_id: receiver.id,
      p_message_ids: [messageId],
      p_mark_read: true,
    },
    `${direction}_receiver_ack`,
  );
  expect(ackCount).toBe(1);

  const afterAck = await gatewayRpc(
    runId,
    startedAt,
    receiver.user,
    '/v1/rpc/aegis_sync_device',
    { p_device_id: receiver.id, p_limit: 50 },
    `${direction}_receiver_resync`,
  ) as SyncRow[];
  expect(afterAck.some((candidate) => candidate.message_id === messageId)).toBe(false);

  safeLog(runId, startedAt, 'message_roundtrip_complete', {
    direction,
    message_ref: hashRef(messageId),
    sender_device_ref: hashRef(sender.id),
    receiver_device_ref: hashRef(receiver.id),
    ratchet_envelope: true,
    exact_plaintext_match: true,
    plaintext_sha256: createHash('sha256').update(plaintext).digest('hex'),
    acked: true,
    pending_after_ack: 0,
  });

  return messageId;
}

(LIVE ? describe : describe.skip)('Aegis live iOS ↔ Windows bidirectional delivery', () => {
  it('enrolls server-assigned devices and decrypts messages in both directions', async () => {
    if (!supabaseUrl || !publishableKey || !gatewayUrl) {
      throw new Error('LIVE_CONFIGURATION_MISSING');
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    const iosPlaintext = `iPhone vers Windows ${runId}`;
    const windowsPlaintext = `Windows vers iPhone ${runId}`;

    safeLog(runId, startedAt, 'scenario_started', {
      users: 2,
      devices: 2,
      platforms: ['ios', 'windows-web'],
      gateway: 'production_aegis',
      enrollment: 'server_assigned_device_ids',
      transport: 'x3dh_double_ratchet',
    });

    await clearAllDeviceSessions();
    try {
      const iosUser = await anonymousSignup(runId, startedAt, 'IOS');
      const windowsUser = await anonymousSignup(runId, startedAt, 'WINDOWS');
      const iphone = await enrollDevice(runId, startedAt, iosUser, 'IPHONE');
      const windows = await enrollDevice(runId, startedAt, windowsUser, 'WINDOWS');

      const conversationId = await directRpc(
        runId,
        startedAt,
        iosUser,
        'create_or_get_dm_conversation',
        { p_other_user: windowsUser.id },
        'conversation_created',
      );
      expect(typeof conversationId).toBe('string');

      await setActiveUser(iosUser);
      const bundle = await fetchPrekeyBundleForDevice(windowsUser.id, windows.id, {
        conversationId,
        senderDeviceId: iphone.id,
      });
      expect(bundle).toBeTruthy();
      expect(bundle!.identityKey).toBe(windows.authorization.deviceKx.publicB64);
      expect(bundle!.oneTimePrekey).toBeTruthy();

      const initiated = await x3dhInitiate(
        { privateKey: iphone.authorization.deviceKx.privateKey },
        bundle!,
      );
      const initialMessage = {
        ik: iphone.authorization.deviceKx.publicB64,
        ek: initiated.ephemeralKey,
        spkId: initiated.usedSPKId,
        opkId: initiated.usedOTPKId,
      };

      await setActiveUser(windowsUser);
      const responded = await x3dhRespondForDevice(
        { privateKey: windows.authorization.deviceKx.privateKey },
        windowsUser.id,
        windows.id,
        initialMessage,
      );
      expect(
        Buffer.from(new Uint8Array(initiated.sharedSecret)).equals(
          Buffer.from(new Uint8Array(responded.sharedSecret)),
        ),
      ).toBe(true);

      const sessionId = await establishDeviceSession(
        iosUser.id,
        iphone.id,
        windowsUser.id,
        windows.id,
        initiated.sharedSecret,
        undefined,
        {
          isInitiator: true,
          peerInitialDhPubB64: bundle!.signedPrekey,
          peerSpkId: bundle!.signedPrekeyId,
          selfIkPubB64: iphone.authorization.deviceKx.publicB64,
          peerIkPubB64: windows.authorization.deviceKx.publicB64,
        },
      );
      await establishResponderRatchetFromDeviceX3DH({
        myUserId: windowsUser.id,
        myDeviceId: windows.id,
        peerUserId: iosUser.id,
        peerDeviceId: iphone.id,
        sharedSecret: responded.sharedSecret,
        sessionId,
        spkId: bundle!.signedPrekeyId,
        selfIkPubB64: windows.authorization.deviceKx.publicB64,
        peerIkPubB64: iphone.authorization.deviceKx.publicB64,
      });
      await finalizeDeviceX3DHInitial({
        userId: windowsUser.id,
        deviceId: windows.id,
        replayReservation: responded.replayReservation,
        usedOpkId: responded.usedOpkId,
      });

      safeLog(runId, startedAt, 'x3dh_session_established', {
        shared_secret_match: true,
        dh_terms: 4,
        initiator: 'iphone',
        responder: 'windows',
        session_ref: hashRef(sessionId),
        used_spk_ref: hashRef(bundle!.signedPrekeyId),
        used_opk_ref: hashRef(bundle!.oneTimePrekeyId),
      });

      const iosMessageId = await sendAndReceive({
        runId,
        startedAt,
        conversationId,
        sender: iphone,
        receiver: windows,
        plaintext: iosPlaintext,
        direction: 'ios_to_windows',
      });
      const windowsMessageId = await sendAndReceive({
        runId,
        startedAt,
        conversationId,
        sender: windows,
        receiver: iphone,
        plaintext: windowsPlaintext,
        direction: 'windows_to_ios',
      });

      safeLog(runId, startedAt, 'scenario_complete', {
        ok: true,
        users: 2,
        devices: 2,
        server_assigned_device_ids: 2,
        ready_routes: 2,
        account_bindings_verified: 2,
        device_authorizations_verified: 2,
        signed_prekeys_published: 2,
        one_time_prekeys_published: 200,
        x3dh_shared_secret_match: true,
        double_ratchet_messages: 2,
        ios_to_windows_plaintext_match: true,
        windows_to_ios_plaintext_match: true,
        successful_acks: 2,
        pending_after_ack: 0,
        ios_message_ref: hashRef(iosMessageId),
        windows_message_ref: hashRef(windowsMessageId),
        duration_ms: Date.now() - startedAt,
      });
    } finally {
      await clearAllDeviceSessions();
      await supabase.auth.signOut();
    }
  }, 240_000);
});
