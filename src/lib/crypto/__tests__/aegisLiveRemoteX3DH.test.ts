// @ts-nocheck
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { supabase } from '@/integrations/supabase/client';
import { prepareDeviceAuthorization } from '../deviceIdentity';
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

const LIVE = process.env.AEGIS_LIVE_REMOTE_X3DH === '1';
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const publishableKey = String(process.env.SUPABASE_ANON_KEY || '');
const gatewayUrl = String(process.env.AEGIS_GATEWAY_URL || '').replace(/\/+$/, '');
const encoder = new TextEncoder();

interface LiveUser {
  id: string;
  token: string;
  refreshToken: string;
  label: string;
}

interface LiveDevice {
  user: LiveUser;
  id: string;
  label: string;
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
  console.log(`AEGIS_REMOTE_X3DH ${JSON.stringify({
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
  label: string,
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
        name: `Aegis Remote X3DH ${label}`,
        aegis_live_remote_x3dh_run: runId,
        aegis_live_remote_x3dh_label: label,
      },
    }),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => null);
  if (
    !response.ok ||
    !payload?.access_token ||
    !payload?.refresh_token ||
    !payload?.user?.id
  ) {
    throw new Error(
      `ANONYMOUS_SIGNUP_FAILED:${response.status}:${payload?.message || payload?.msg || 'unknown'}`,
    );
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
    throw new Error(
      `${stage.toUpperCase()}_FAILED:${payload?.code || response.status}:${payload?.message || 'unknown'}`,
    );
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
  const requestId = `remote-x3dh-${stage}-${randomUUID()}`;
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${user.token}`,
      'content-type': 'application/json',
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
    throw new Error(
      `${stage.toUpperCase()}_FAILED:${payload?.error?.code || response.status}:${payload?.error?.message || 'unknown'}`,
    );
  }
  return payload?.data;
}

async function registerDevice(
  runId: string,
  startedAt: number,
  user: LiveUser,
  label: string,
): Promise<LiveDevice> {
  await setActiveUser(user);
  const id = `live-x3dh-${label.toLowerCase()}-${randomUUID()}`;
  const authorization = await prepareDeviceAuthorization(user.id, id);
  const result = await directRpc(
    runId,
    startedAt,
    user,
    'register_user_device_safe',
    {
      p_user_id: user.id,
      p_device_id: id,
      p_device_name: `Aegis remote X3DH ${label}`,
      p_device_public_key: authorization.deviceKx.publicB64,
      p_device_fingerprint: `remote-x3dh-${hashRef(id)}`,
      p_platform: 'web',
      p_user_agent: 'aegis-live-remote-x3dh/1',
      p_device_signing_key: authorization.deviceSigning.publicB64,
      p_device_authorization_signature: authorization.authorizationSignature,
      p_account_identity_key: authorization.account.identityKey,
      p_account_signing_key: authorization.account.signingKey,
      p_account_fingerprint: authorization.account.fingerprint,
      p_account_binding_signature: authorization.account.bindingSignature,
    },
    `device_registered_${label}`,
  );
  if (result?.ok !== true) {
    throw new Error(`DEVICE_REGISTRATION_REJECTED:${label}:${result?.code || 'UNKNOWN'}`);
  }
  safeLog(runId, startedAt, 'device_authorized', {
    label,
    user_ref: hashRef(user.id),
    device_ref: hashRef(id),
    code: result.code,
  });
  return { user, id, label, authorization };
}

async function createParentBody(
  messageId: string,
  conversationId: string,
  senderId: string,
  runId: string,
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
  const aad = encoder.encode(
    `FORSURE-AEGIS-MESSAGE-v1|${messageId}|${conversationId}|${senderId}`,
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    encoder.encode(`Aegis remote X3DH route marker ${runId}`),
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

(LIVE ? describe : describe.skip)('Aegis live remote-directory X3DH bootstrap', () => {
  it('publishes, verifies and consumes remote prekeys before a durable ratchet delivery', async () => {
    if (!supabaseUrl || !publishableKey || !gatewayUrl) {
      throw new Error('LIVE_CONFIGURATION_MISSING');
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    const plaintext =
      'Bootstrap X3DH distant validé — premier message Double Ratchet déchiffré en clair.';

    safeLog(runId, startedAt, 'scenario_started', {
      users: 2,
      devices: 2,
      directory: 'live_lovable_cloud',
      gateway: 'vercel_preview',
      bootstrap: 'production_x3dh_with_remote_spk_and_opk',
    });

    await clearAllDeviceSessions();
    try {
      const userA = await anonymousSignup(runId, startedAt, 'A');
      const userB = await anonymousSignup(runId, startedAt, 'B');
      const A1 = await registerDevice(runId, startedAt, userA, 'A1');
      const B1 = await registerDevice(runId, startedAt, userB, 'B1');

      await setActiveUser(userB);
      const publishedSpk = await generateAndUploadDeviceSignedPrekey(
        userB.id,
        B1.id,
        B1.authorization.deviceSigning.privateKey,
      );
      await refillDeviceOneTimePrekeysIfNeeded(userB.id, B1.id);
      const opkCountBefore = Number(await directRpc(
        runId,
        startedAt,
        userB,
        'count_device_one_time_prekeys',
        { p_user_id: userB.id, p_device_id: B1.id },
        'receiver_opk_count_before_claim',
      ));
      expect(opkCountBefore).toBe(100);
      safeLog(runId, startedAt, 'remote_prekeys_published', {
        receiver_device_ref: hashRef(B1.id),
        spk_ref: hashRef(publishedSpk.spkId),
        active_spk_count: 1,
        available_opks: opkCountBefore,
      });

      const conversationId = await directRpc(
        runId,
        startedAt,
        userA,
        'create_or_get_dm_conversation',
        { p_other_user: userB.id },
        'conversation_created',
      );
      expect(typeof conversationId).toBe('string');

      await setActiveUser(userA);
      const verifiedReceiver = await fetchVerifiedDeviceIdentity(userB.id, B1.id);
      expect(verifiedReceiver).toBeTruthy();
      expect(verifiedReceiver!.devicePublicKey).toBe(
        B1.authorization.deviceKx.publicB64,
      );
      expect(verifiedReceiver!.deviceSigningKey).toBe(
        B1.authorization.deviceSigning.publicB64,
      );
      safeLog(runId, startedAt, 'remote_directory_identity_verified', {
        account_binding_valid: true,
        device_authorization_valid: true,
        receiver_device_ref: hashRef(B1.id),
      });

      const bundle = await fetchPrekeyBundleForDevice(userB.id, B1.id, {
        conversationId,
        senderDeviceId: A1.id,
      });
      expect(bundle).toBeTruthy();
      expect(bundle!.signedPrekeyId).toBe(publishedSpk.spkId);
      expect(bundle!.identityKey).toBe(B1.authorization.deviceKx.publicB64);
      expect(bundle!.oneTimePrekey).toBeTruthy();
      expect(bundle!.oneTimePrekeyId).toBeTypeOf('number');

      const secondBundle = await fetchPrekeyBundleForDevice(userB.id, B1.id, {
        conversationId,
        senderDeviceId: A1.id,
      });
      expect(secondBundle?.oneTimePrekeyId).toBeTypeOf('number');
      expect(secondBundle!.oneTimePrekeyId).not.toBe(bundle!.oneTimePrekeyId);
      safeLog(runId, startedAt, 'remote_bundle_claimed', {
        spk_signature_valid: true,
        first_opk_ref: hashRef(bundle!.oneTimePrekeyId),
        second_opk_ref: hashRef(secondBundle!.oneTimePrekeyId),
        claimed_opks_distinct: true,
      });

      await setActiveUser(userB);
      const opkCountAfter = Number(await directRpc(
        runId,
        startedAt,
        userB,
        'count_device_one_time_prekeys',
        { p_user_id: userB.id, p_device_id: B1.id },
        'receiver_opk_count_after_claims',
      ));
      expect(opkCountAfter).toBe(98);

      await setActiveUser(userA);
      const initiated = await x3dhInitiate(
        { privateKey: A1.authorization.deviceKx.privateKey },
        bundle!,
      );
      expect(initiated.usedOTPKId).toBe(bundle!.oneTimePrekeyId);

      const initialMessage = {
        ik: A1.authorization.deviceKx.publicB64,
        ek: initiated.ephemeralKey,
        spkId: initiated.usedSPKId,
        opkId: initiated.usedOTPKId,
      };

      await setActiveUser(userB);
      const responded = await x3dhRespondForDevice(
        { privateKey: B1.authorization.deviceKx.privateKey },
        userB.id,
        B1.id,
        initialMessage,
      );
      expect(
        Buffer.from(new Uint8Array(initiated.sharedSecret)).equals(
          Buffer.from(new Uint8Array(responded.sharedSecret)),
        ),
      ).toBe(true);
      safeLog(runId, startedAt, 'x3dh_shared_secret_confirmed', {
        dh_terms: 4,
        used_spk_ref: hashRef(initiated.usedSPKId),
        used_opk_ref: hashRef(initiated.usedOTPKId),
        shared_secret_match: true,
      });

      const sessionId = await establishDeviceSession(
        userA.id,
        A1.id,
        userB.id,
        B1.id,
        initiated.sharedSecret,
        undefined,
        {
          isInitiator: true,
          peerInitialDhPubB64: bundle!.signedPrekey,
          peerSpkId: bundle!.signedPrekeyId,
          selfIkPubB64: A1.authorization.deviceKx.publicB64,
          peerIkPubB64: B1.authorization.deviceKx.publicB64,
        },
      );
      await establishResponderRatchetFromDeviceX3DH({
        myUserId: userB.id,
        myDeviceId: B1.id,
        peerUserId: userA.id,
        peerDeviceId: A1.id,
        sharedSecret: responded.sharedSecret,
        sessionId,
        spkId: bundle!.signedPrekeyId,
        selfIkPubB64: B1.authorization.deviceKx.publicB64,
        peerIkPubB64: A1.authorization.deviceKx.publicB64,
      });
      await finalizeDeviceX3DHInitial({
        userId: userB.id,
        deviceId: B1.id,
        replayReservation: responded.replayReservation,
        usedOpkId: responded.usedOpkId,
      });

      let replayRejected = false;
      try {
        await x3dhRespondForDevice(
          { privateKey: B1.authorization.deviceKx.privateKey },
          userB.id,
          B1.id,
          initialMessage,
        );
      } catch {
        replayRejected = true;
      }
      expect(replayRejected).toBe(true);
      safeLog(runId, startedAt, 'x3dh_initial_replay_rejected', {
        replay_rejected: true,
      });

      const encryptedBody = await ratchetEncrypt(
        userA.id,
        A1.id,
        userB.id,
        B1.id,
        plaintext,
      );
      expect(encryptedBody).toBeTruthy();
      expect(encryptedBody!.startsWith(AEGIS_RATCHET_PREFIX)).toBe(true);

      const messageId = randomUUID();
      const parentBody = await createParentBody(
        messageId,
        conversationId,
        userA.id,
        runId,
      );
      const routeVersion = await directRpc(
        runId,
        startedAt,
        userA,
        'get_aegis_conversation_route_version',
        { p_conversation_id: conversationId },
        'route_version_loaded',
      );
      const receipt = await gatewayRpc(
        runId,
        startedAt,
        userA,
        '/v1/rpc/aegis_send_message',
        {
          p_message_id: messageId,
          p_conversation_id: conversationId,
          p_body: parentBody,
          p_image_url: null,
          p_extra: { live_remote_x3dh_run: runId },
          p_copies: [{
            message_id: messageId,
            recipient_user_id: userB.id,
            recipient_device_id: B1.id,
            sender_user_id: userA.id,
            sender_device_id: A1.id,
            encrypted_body: encryptedBody,
          }],
          p_sender_device_id: A1.id,
          p_route_version: routeVersion,
        },
        'message_committed',
      );
      expect(receipt?.state).toBe('committed');
      expect(receipt?.message_id).toBe(messageId);

      const rows = await gatewayRpc(
        runId,
        startedAt,
        userB,
        '/v1/rpc/aegis_sync_device',
        { p_device_id: B1.id, p_limit: 50 },
        'receiver_sync',
      ) as SyncRow[];
      const row = rows.find((candidate) => candidate.message_id === messageId);
      expect(row).toBeTruthy();
      const recovered = await ratchetDecrypt(userB.id, B1.id, row!.encrypted_body);
      expect(recovered).toBe(plaintext);
      safeLog(runId, startedAt, 'plaintext_recovered', {
        message_ref: hashRef(messageId),
        receiver_device_ref: hashRef(B1.id),
        plaintext_match: true,
        plaintext_sha256: createHash('sha256').update(plaintext).digest('hex'),
      });

      const ackCount = await gatewayRpc(
        runId,
        startedAt,
        userB,
        '/v1/rpc/aegis_ack_device_messages',
        {
          p_device_id: B1.id,
          p_message_ids: [messageId],
          p_mark_read: true,
        },
        'receiver_ack',
      );
      expect(ackCount).toBe(1);
      const afterAck = await gatewayRpc(
        runId,
        startedAt,
        userB,
        '/v1/rpc/aegis_sync_device',
        { p_device_id: B1.id, p_limit: 50 },
        'receiver_resync',
      ) as SyncRow[];
      expect(afterAck.some((candidate) => candidate.message_id === messageId)).toBe(false);

      safeLog(runId, startedAt, 'scenario_complete', {
        ok: true,
        users: 2,
        devices: 2,
        published_spks: 1,
        published_opks: 100,
        claimed_opks: 2,
        remaining_opks: opkCountAfter,
        x3dh_dh_terms: 4,
        shared_secret_match: true,
        replay_rejected: true,
        ratchet_messages: 1,
        exact_plaintext_decryptions: 1,
        successful_acks: 1,
        pending_after_ack: 0,
        message_ref: hashRef(messageId),
        duration_ms: Date.now() - startedAt,
      });
    } finally {
      await clearAllDeviceSessions();
    }
  }, 240_000);
});
