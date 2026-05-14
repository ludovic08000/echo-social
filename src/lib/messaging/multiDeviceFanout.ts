/**
 * Multi-device fan-out — distributes a sent message as additional, per-device
 * encrypted copies in `message_device_copies`.
 *
 * Two encryption paths per recipient device, in this order:
 *   1. **X3DH-per-device** (preferred):
 *      - fetch the device's signed prekey bundle (`get_device_prekey_bundle`)
 *      - run a fresh X3DH handshake → 32-byte shared secret
 *      - AES-256-GCM encrypt the plaintext with that secret
 *      - the receiver re-runs X3DH responder using its OWN device SPK private
 *        key to derive the same secret
 *   2. **Device-wrap fallback** (legacy compatible):
 *      - direct ECDH between sender identity ↔ recipient device public key
 *      - used when the target device has not yet published a SPK
 *
 * Strictly additive. The original `messages` row (encrypted with the per-conv
 * Double Ratchet) remains the source of truth for the primary device.
 * Failure of fan-out is non-fatal: the message is still delivered via the
 * legacy single-device ratchet path.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';
import { unwrapPlaintextForDevice } from './deviceWrap';
import { requestMessageRefanout } from './deviceCopyRetryRequest';
import {
  fetchPrekeyBundleForDevice,
  invalidateDeviceBundleCache,
  peekDeviceSignedPrekey,
  x3dhInitiate,
  x3dhRespond,
  x3dhRespondForDevice,
} from '@/lib/crypto/x3dh';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManager';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import {
  ratchetEncrypt,
  ratchetDecryptWithSession,
  establishDeviceSession,
  getSessionPeerSpkId,
  invalidateDeviceSession,
  RATCHET_PREFIX_V3,
  RATCHET_PREFIX_V4,
} from '@/lib/crypto/deviceRatchet';
import { logCryptoException, logCryptoError } from '@/lib/crypto/errorLogger';

interface FanoutInput {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  plaintext: string;
}

interface ActiveDevice {
  user_id: string;
  device_id: string;
  device_public_key: string;
}

export interface FanoutResult {
  inserted: number;
  targeted: number;
  failed: number;
  multiDevice: boolean;
}

interface DeviceEncryptTargetInput {
  conversationId?: string;
  senderUserId: string;
  senderDeviceId?: string;
  recipientUserId: string;
  recipientDeviceId: string;
  recipientDevicePublicKey: string;
  plaintext: string;
}

function emptyFanout(multiDevice = false): FanoutResult {
  return { inserted: 0, targeted: 0, failed: 0, multiDevice };
}

function dedupeDevices(devices: ActiveDevice[]): ActiveDevice[] {
  const seen = new Set<string>();
  const out: ActiveDevice[] = [];
  for (const device of devices) {
    if (!device.user_id || !device.device_id || !device.device_public_key) continue;
    const key = `${device.user_id}:${device.device_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(device);
  }
  return out;
}

async function loadCurrentSenderDevice(senderUserId: string, senderDeviceId: string): Promise<ActiveDevice | null> {
  try {
    const { data } = await supabase
      .from('user_devices')
      .select('user_id, device_id, device_public_key, is_active, revoked_at')
      .eq('user_id', senderUserId)
      .eq('device_id', senderDeviceId)
      .maybeSingle();

    if (!data?.device_public_key || !data.is_active || data.revoked_at) return null;
    return {
      user_id: data.user_id,
      device_id: data.device_id,
      device_public_key: data.device_public_key,
    };
  } catch {
    return null;
  }
}

// ─── X3DH-wrapped envelopes ─────────────────────────────────────────────────
// Two on-wire formats, both per-device:
//   v1 (legacy, no OPK): "x3dh1." iv "." ct "." ek "." spkId
//   v2 (with OPK):       "x3dh2." iv "." ct "." ek "." spkId "." opkId
// On read we detect the prefix and route to the right responder.
const X3DH_PREFIX_V1 = 'x3dh1.';
const X3DH_PREFIX_V2 = 'x3dh2.';

async function aesFromSecret(secret: ArrayBuffer): Promise<CryptoKey> {
  return hardCrypto.importKey('raw', secret.slice(0, 32), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function x3dhWrapForDevice(
  plaintext: string,
  senderUserId: string,
  recipientUserId: string,
  recipientDeviceId: string,
): Promise<string | null> {
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
    const bundle = await fetchPrekeyBundleForDevice(
      recipientUserId,
      recipientDeviceId,
      { forceRefresh: attempt > 0, retryOnInvalidSignature: true },
    );
    if (!bundle) return null;

    const myKeys = await getOrCreateIdentityKeys(senderUserId);
    const result = await x3dhInitiate(myKeys, bundle);
    const aes = await aesFromSecret(result.sharedSecret);
    const iv = randomBytes(12);
    const ct = await hardCrypto.encrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
      aes,
      new hardGlobals.TextEncoder().encode(plaintext),
    );

    const head = result.usedOTPKId !== undefined ? X3DH_PREFIX_V2 : X3DH_PREFIX_V1;
    const parts = [
      head + bufferToBase64(iv.buffer as ArrayBuffer),
      bufferToBase64(ct as ArrayBuffer),
      result.ephemeralKey,
      String(result.usedSPKId),
    ];
    if (result.usedOTPKId !== undefined) parts.push(String(result.usedOTPKId));

    // After a successful X3DH, cache the device-pair session so subsequent
    // messages skip the full handshake. The peer's SPK acts as their initial
    // DH ratchet public key — initiator immediately performs a DH-ratchet
    // step so the very first DR message carries a fresh ratchet pub.
    try {
      const myDeviceId = getCurrentDeviceId();
      await establishDeviceSession(
        senderUserId, myDeviceId,
        recipientUserId, recipientDeviceId,
        result.sharedSecret,
        undefined,
        {
          peerInitialDhPubB64: bundle.signedPrekey,
          isInitiator: true,
          peerSpkId: bundle.signedPrekeyId,
        },
      );
    } catch {
      // Non-fatal: session cache write failure means the next message will
      // re-run X3DH. Silenced to keep the hot path quiet.
    }

    return parts.join('.');
    } catch (e) {
      if (attempt === 0) {
        invalidateDeviceBundleCache(recipientUserId, recipientDeviceId, 'x3dh_wrap_failed');
        logCryptoError({
          severity: 'warning',
          context: 'fanout',
          errorCode: 'E_REFETCH_BUNDLE_RETRY',
          errorMessage: 'Retrying X3DH once after device bundle/session failure',
          peerUserId: recipientUserId,
          peerDeviceId: recipientDeviceId,
          metadata: { stage: 'x3dh_wrap', senderUserId },
        });
        continue;
      }
      logCryptoException('fanout', e, {
        severity: 'warning',
        peerUserId: recipientUserId,
        peerDeviceId: recipientDeviceId,
        metadata: { stage: 'x3dh_wrap_retry_exhausted', senderUserId },
      });
      return null;
    }
  }
  return null;
}

async function x3dhUnwrapForDevice(
  payload: string,
  recipientUserId: string,
  senderIdentityKeyB64: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<string | null> {
  try {
    const isV2 = payload.startsWith(X3DH_PREFIX_V2);
    const isV1 = payload.startsWith(X3DH_PREFIX_V1);
    if (!isV1 && !isV2) return null;

    const prefix = isV2 ? X3DH_PREFIX_V2 : X3DH_PREFIX_V1;
    const parts = payload.slice(prefix.length).split('.');
    const expectedLen = isV2 ? 5 : 4;
    if (parts.length !== expectedLen) return null;

    const [ivB64, ctB64, ekB64, spkIdStr, opkIdStr] = parts;
    const spkId = parseInt(spkIdStr, 10);
    if (Number.isNaN(spkId)) return null;
    const opkId = isV2 ? parseInt(opkIdStr, 10) : undefined;
    if (isV2 && Number.isNaN(opkId as number)) return null;

    const myKeys = await getOrCreateIdentityKeys(recipientUserId);
    const myDeviceId = getCurrentDeviceId();

    // Per-device responder: loads device-scoped SPK private + (optionally) the OPK private.
    const { sharedSecret, spkKeyPair } = await x3dhRespondForDevice(myKeys, recipientUserId, myDeviceId, {
      ik: senderIdentityKeyB64,
      ek: ekB64,
      spkId,
      opkId,
    });
    const aes = await aesFromSecret(sharedSecret);
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(ivB64)), tagLength: 128 },
      aes,
      base64ToBuffer(ctB64),
    );

    // Cache the device-pair session so the NEXT message from this peer device
    // can be decrypted via the v3 fast path (no X3DH respond needed).
    // SESAME PRIMING: seed our local DH ratchet pair with the device SPK
    // keypair. This mirrors what the initiator did
    // (`DH(initiatorEphemeral, SPK_pub)`) so the very first inbound v4
    // message can complete a DH-ratchet step without us having to send first.
    try {
      const spkPrivJwk = await hardCrypto.exportKey('jwk', spkKeyPair.privateKey);
      const spkPubRaw = await hardCrypto.exportKey('raw', spkKeyPair.publicKey);
      const spkPubB64 = bufferToBase64(spkPubRaw as ArrayBuffer);
      await establishDeviceSession(
        recipientUserId, myDeviceId,
        senderUserId, senderDeviceId,
        sharedSecret,
        undefined,
        {
          isInitiator: false,
          peerSpkId: spkId,
          selfInitialDhPrivJwk: spkPrivJwk,
          selfInitialDhPubB64: spkPubB64,
        },
      );
    } catch {
      // Non-fatal: session cache write failure means the next message will
      // re-run X3DH. Silenced to keep the hot path quiet.
    }

    return new hardGlobals.TextDecoder().decode(pt);
  } catch {
    // X3DH unwrap failed. Legacy deviceWrap reads are attempted only by the
    // outer compatibility path for historical copies.
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function encryptPlaintextForDeviceTarget(
  input: DeviceEncryptTargetInput,
): Promise<{ encryptedBody: string; senderDeviceId: string } | null> {
  if (!input.recipientDevicePublicKey) return null;
  if (isDeviceIdTemporary()) return null;

  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();

  try {
    const cachedSpkId = await getSessionPeerSpkId(
      input.senderUserId,
      senderDeviceId,
      input.recipientUserId,
      input.recipientDeviceId,
    );
    if (cachedSpkId !== null) {
      const spk = await peekDeviceSignedPrekey(input.recipientUserId, input.recipientDeviceId);
      if (spk && spk.signedPrekeyId !== cachedSpkId) {
        await invalidateDeviceSession(
          input.senderUserId,
          senderDeviceId,
          input.recipientUserId,
          input.recipientDeviceId,
        );
      }
    }
  } catch (e) {
    logCryptoException('fanout', e, {
      severity: 'warning',
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
      metadata: { stage: 'spk_rotation_check' },
    });
  }

  let encrypted: string | null = null;
  try {
    encrypted = await ratchetEncrypt(
      input.senderUserId,
      senderDeviceId,
      input.recipientUserId,
      input.recipientDeviceId,
      input.plaintext,
    );
    if (encrypted && !encrypted.startsWith(RATCHET_PREFIX_V4)) {
      encrypted = null;
    }
  } catch (e) {
    logCryptoException('fanout', e, {
      severity: 'warning',
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
      metadata: { stage: 'ratchet_encrypt' },
    });
  }

  if (!encrypted) {
    encrypted = await x3dhWrapForDevice(
      input.plaintext,
      input.senderUserId,
      input.recipientUserId,
      input.recipientDeviceId,
    );
  }

  if (!encrypted) {
    logCryptoError({
      severity: 'error',
      context: 'fanout',
      errorCode: 'E_AUTHENTICATED_DEVICE_COPY_UNAVAILABLE',
      errorMessage: 'No authenticated device-copy path available; refusing unsigned deviceWrap fallback',
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
      metadata: { stage: 'spk_required' },
    });
    return null;
  }

  return encrypted ? { encryptedBody: encrypted, senderDeviceId } : null;
}

export async function fanoutMessageCopies(input: FanoutInput): Promise<FanoutResult> {
  // SAFETY: Never bind a fresh ratchet session to a temporary device id —
  // doing so would orphan all session state once Keychain hydrates with
  // the real one. Skip fan-out entirely; the per-conv ratchet still
  // delivers to the primary device.
  if (isDeviceIdTemporary()) {
    // Silent skip: per-conv ratchet still delivers to the primary device.
    return emptyFanout(false);
  }
  const senderDeviceId = getCurrentDeviceId();

  // 1. Get all participants of the conversation
  const { data: participants } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', input.conversationId);

  if (!participants?.length) return emptyFanout(false);
  const userIds = participants.map(p => p.user_id);

  // 2. List active devices per participant
  const deviceLists = await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.rpc('list_active_devices_for_user', { p_user_id: uid });
        return (data || []).map((d: any) => ({
          user_id: uid,
          device_id: d.device_id as string,
          device_public_key: d.device_public_key as string,
        })) as ActiveDevice[];
      } catch {
        return [] as ActiveDevice[];
      }
    }),
  );
  const allDevices = deviceLists.flat();

  // Every message must have a decryptable copy for every active participant
  // device, including all devices of the sender's own account. The current
  // sender device is added explicitly if the RPC missed a fresh registration.
  const targets = dedupeDevices(allDevices);
  const senderTargetKey = `${input.senderUserId}:${senderDeviceId}`;
  if (!targets.some(dev => `${dev.user_id}:${dev.device_id}` === senderTargetKey)) {
    const senderDevice = await loadCurrentSenderDevice(input.senderUserId, senderDeviceId);
    if (senderDevice) targets.unshift(senderDevice);
  }
  if (targets.length === 0) return emptyFanout(false);

  // 3. For each target device:
  //    pre) detect peer SPK rotation → invalidate stale session (avoids
  //         silent decryption failures on the recipient side)
  //    a)   ratchet v3/v4 (existing session, fastest)
  //    b)   X3DH per-device (v1/v2, also caches a session for next time)
  //    c)   refuse send if no authenticated per-device path is available
  const rows: Array<Record<string, string>> = [];
  let failed = 0;
  for (const dev of targets) {
    if (!dev.device_public_key) {
      failed++;
      continue;
    }

    // (pre) Check whether the cached session was negotiated against an SPK
    // that the peer has since rotated. If so, drop the session so step (b)
    // re-runs X3DH with the fresh prekey. We only fetch the bundle when a
    // session actually exists (cheap fast-path otherwise).
    try {
      const cachedSpkId = await getSessionPeerSpkId(
        input.senderUserId, senderDeviceId, dev.user_id, dev.device_id,
      );
      if (cachedSpkId !== null) {
        const spk = await peekDeviceSignedPrekey(dev.user_id, dev.device_id);
        if (spk && spk.signedPrekeyId !== cachedSpkId) {
          await invalidateDeviceSession(
            input.senderUserId, senderDeviceId, dev.user_id, dev.device_id,
          );
        }
      }
    } catch (e) {
      logCryptoException('fanout', e, {
        severity: 'warning',
        conversationId: input.conversationId,
        myDeviceId: senderDeviceId,
        peerUserId: dev.user_id,
        peerDeviceId: dev.device_id,
        metadata: { stage: 'spk_rotation_check' },
      });
    }

    // (a) Try the cached device-pair ratchet first. STRICT v4 — if the
    //     cache returns a v3 envelope (legacy session that hasn't been
    //     re-bootstrapped yet), drop it and force fresh X3DH below so new
    //     traffic stays on Double Ratchet w/ DH ratchet.
    let encrypted: string | null = null;
    try {
      encrypted = await ratchetEncrypt(
        input.senderUserId, senderDeviceId,
        dev.user_id, dev.device_id,
        input.plaintext,
      );
      if (encrypted && !encrypted.startsWith(RATCHET_PREFIX_V4)) {
        encrypted = null;
      }
    } catch (e) {
      logCryptoException('fanout', e, {
        severity: 'warning',
        conversationId: input.conversationId,
        myDeviceId: senderDeviceId,
        peerUserId: dev.user_id,
        peerDeviceId: dev.device_id,
        metadata: { stage: 'ratchet_encrypt' },
      });
    }

    // (b) Fresh X3DH (v1 or v2) — this also seeds the ratchet for next time.
    if (!encrypted) {
      encrypted = await x3dhWrapForDevice(
        input.plaintext,
        input.senderUserId,
        dev.user_id,
        dev.device_id,
      );
    }

    if (!encrypted) {
      logCryptoError({
        severity: 'error',
        context: 'fanout',
        errorCode: 'E_AUTHENTICATED_DEVICE_COPY_UNAVAILABLE',
        errorMessage: 'No authenticated device-copy path available; refusing unsigned deviceWrap fallback',
        conversationId: input.conversationId,
        myDeviceId: senderDeviceId,
        peerUserId: dev.user_id,
        peerDeviceId: dev.device_id,
        metadata: { stage: 'spk_required' },
      });
      failed++;
      continue;
    }

    rows.push({
      message_id: input.messageId,
      recipient_user_id: dev.user_id,
      recipient_device_id: dev.device_id,
      sender_user_id: input.senderUserId,
      sender_device_id: senderDeviceId,
      encrypted_body: encrypted,
    });
  }

  if (!rows.length) return { inserted: 0, targeted: targets.length, failed, multiDevice: true };

  const { error } = await supabase
    .from('message_device_copies')
    .upsert(rows as any, {
      onConflict: 'message_id,recipient_device_id',
      ignoreDuplicates: true,
    });
  if (error) {
    logCryptoError({
      severity: 'error',
      context: 'fanout',
      errorCode: 'E_FANOUT_INSERT',
      errorMessage: error.message,
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      metadata: { rows: rows.length },
    });
    return { inserted: 0, targeted: targets.length, failed: targets.length, multiDevice: true };
  }

  if (failed > 0) {
    logCryptoError({
      severity: 'warning',
      context: 'fanout',
      errorCode: 'E_FANOUT_PARTIAL',
      errorMessage: 'Some active devices did not receive an encrypted copy',
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      metadata: { targeted: targets.length, inserted: rows.length, failed },
    });
  }

  // 4. Tag the parent message as multi-device for downstream readers
  await supabase
    .from('messages')
    .update({ body_kind: 'multi_device' } as any)
    .eq('id', input.messageId);

  return { inserted: rows.length, targeted: targets.length, failed, multiDevice: true };
}

/**
 * Try to read a message via the per-device copy table.
 * Returns plaintext or null. Used by DecryptedMessageBody as fallback when the
 * ratchet decrypt fails (typical case: secondary device).
 */
export async function tryReadDeviceCopy(messageId: string, expectedSenderUserId?: string): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  try {
    // Primary: copy explicitly addressed to this device_id.
    type CopyRow = {
      encrypted_body: string;
      sender_user_id: string;
      sender_device_id: string;
      recipient_device_id?: string;
    };
    let rows: CopyRow[] = [];
    const { data: targeted } = await supabase.rpc('get_device_copy_for_message', {
      p_message_id: messageId,
      p_device_id: myDeviceId,
    });
    if (targeted && targeted.length > 0) {
      rows = (targeted as CopyRow[]).map(r => ({ ...r, recipient_device_id: r.recipient_device_id ?? myDeviceId }));
    } else {
      // Fallback: device_id changed (localStorage/Keychain wiped on iOS).
      // Try every copy addressed to this user — and for each one, attempt
      // decryption using the ORIGINAL recipient_device_id from the row, since
      // that's the device id the message was actually encrypted for.
      const { data: allCopies } = await supabase.rpc('get_device_copies_for_user', {
        p_message_id: messageId,
      });
      if (!allCopies || allCopies.length === 0) {
        if (expectedSenderUserId) {
          void requestMessageRefanout({ messageId, senderUserId: expectedSenderUserId });
        }
        return null;
      }
      rows = allCopies as CopyRow[];
      logCryptoError({
        severity: 'info',
        context: 'decrypt',
        errorCode: 'DEVICE_COPY_FALLBACK',
        errorMessage: `Trying ${rows.length} device copies for message ${messageId} (current device_id ${myDeviceId} has no targeted copy)`,
        myDeviceId,
        metadata: { messageId, candidates: rows.length },
      });
    }

    if (expectedSenderUserId) {
      const before = rows.length;
      rows = rows.filter(row => row.sender_user_id === expectedSenderUserId);
      if (before !== rows.length) {
        logCryptoError({
          severity: 'warning',
          context: 'decrypt',
          errorCode: 'DEVICE_COPY_SENDER_MISMATCH',
          errorMessage: 'Rejected device copies whose sender does not match parent message',
          myDeviceId,
          metadata: { messageId, expectedSenderUserId, rejected: before - rows.length },
        });
      }
      if (rows.length === 0) {
        void requestMessageRefanout({ messageId, senderUserId: expectedSenderUserId });
        return null;
      }
    }

    // Try each candidate row in order; first successful decryption wins.
    // Use the row's recipient_device_id (when present) so iOS-restored installs
    // can still decrypt copies originally targeted at the previous device id.
    for (const row of rows) {
      const targetDeviceId = row.recipient_device_id || myDeviceId;
      const pt = await tryDecryptCopy(row, user.id, targetDeviceId);
      if (pt !== null) return pt;
    }
    if (expectedSenderUserId) {
      void requestMessageRefanout({ messageId, senderUserId: expectedSenderUserId });
    }
    return null;
  } catch (e) {
    logCryptoException('decrypt', e, {
      severity: 'error',
      myDeviceId,
      metadata: { messageId, stage: 'tryReadDeviceCopy' },
    });
    if (expectedSenderUserId) {
      void requestMessageRefanout({ messageId, senderUserId: expectedSenderUserId });
    }
    return null;
  }
}

/** Attempt decryption of a single device copy row. Returns plaintext or null. */
async function tryDecryptCopy(
  row: { encrypted_body: string; sender_user_id: string; sender_device_id: string },
  userId: string,
  myDeviceId: string,
): Promise<string | null> {
  try {

    // Path 0: cached device-pair ratchet (v3 legacy KDF chain or v4 Double Ratchet).
    if (
      row.encrypted_body.startsWith(RATCHET_PREFIX_V4) ||
      row.encrypted_body.startsWith(RATCHET_PREFIX_V3)
    ) {
      const pt = await ratchetDecryptWithSession(
        userId,
        myDeviceId,
        row.sender_user_id,
        row.sender_device_id,
        row.encrypted_body,
      );
      if (pt !== null) return pt;
      return null;
    }

    if (row.encrypted_body.startsWith(X3DH_PREFIX_V1) || row.encrypted_body.startsWith(X3DH_PREFIX_V2)) {
      const { data: senderPub } = await supabase
        .from('user_public_keys')
        .select('identity_key')
        .eq('user_id', row.sender_user_id)
        .eq('is_active', true)
        .maybeSingle();
      if (!senderPub?.identity_key) return null;
      const pt = await x3dhUnwrapForDevice(
        row.encrypted_body,
        userId,
        senderPub.identity_key,
        row.sender_user_id,
        row.sender_device_id,
      );
      if (pt !== null) return pt;
    }

    const { data: senderDevices } = await supabase.rpc('list_active_devices_for_user', {
      p_user_id: row.sender_user_id,
    });
    const senderDev = (senderDevices || []).find((d: any) => d.device_id === row.sender_device_id);
    if (!senderDev?.device_public_key) return null;

    const { data: senderPubLegacy } = await supabase
      .from('user_public_keys')
      .select('identity_key')
      .eq('user_id', row.sender_user_id)
      .eq('is_active', true)
      .maybeSingle();

    return await unwrapPlaintextForDevice(
      row.encrypted_body,
      userId,
      senderDev.device_public_key,
      myDeviceId,
      senderPubLegacy?.identity_key ?? null,
    );
  } catch {
    // Single-copy decrypt failure — caller iterates remaining rows. Silent.
    return null;
  }
}
