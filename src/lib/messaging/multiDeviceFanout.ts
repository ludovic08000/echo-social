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
import { wrapPlaintextForDevice, unwrapPlaintextForDevice } from './deviceWrap';
import { requestDeviceCopyRetry } from './deviceCopyRetryRequest';
import {
  fetchPrekeyBundleForDevice,
  peekDeviceSignedPrekey,
  x3dhInitiate,
  x3dhRespond,
  x3dhRespondForDevice,
} from '@/lib/crypto/x3dh';
import { getOrCreateIdentityKeys, PinUnlockRequiredError } from '@/lib/crypto/keyManager';
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

interface DeviceEncryptTargetInput {
  conversationId?: string;
  senderUserId: string;
  senderDeviceId?: string;
  recipientUserId: string;
  recipientDeviceId: string;
  recipientDevicePublicKey: string;
  plaintext: string;
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
  try {
    const bundle = await fetchPrekeyBundleForDevice(recipientUserId, recipientDeviceId);
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
    // Bubble PIN-unlock signal up so the UI can prompt the user; never swallow it
    // (otherwise fanout silently downgrades and the message is sent without per-device copies).
    if (e instanceof PinUnlockRequiredError || String(e).toLowerCase().includes('pin unlock required')) {
      throw e;
    }
    // Other errors → caller falls back to deviceWrap. Silent.
    return null;
  }
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
    // X3DH unwrap failed — caller will try deviceWrap legacy path. Silent.
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
    try {
      encrypted = await wrapPlaintextForDevice(
        input.plaintext,
        input.senderUserId,
        input.recipientDevicePublicKey,
        input.recipientDeviceId,
      );
    } catch (e) {
      logCryptoException('fanout', e, {
        severity: 'error',
        conversationId: input.conversationId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
        metadata: { stage: 'all_paths_failed' },
      });
      return null;
    }
  }

  return encrypted ? { encryptedBody: encrypted, senderDeviceId } : null;
}

export async function fanoutMessageCopies(input: FanoutInput): Promise<{ inserted: number; multiDevice: boolean }> {
  // SAFETY: Never bind a fresh ratchet session to a temporary device id —
  // doing so would orphan all session state once Keychain hydrates with
  // the real one. Skip fan-out entirely; the per-conv ratchet still
  // delivers to the primary device.
  if (isDeviceIdTemporary()) {
    // Silent skip: per-conv ratchet still delivers to the primary device.
    return { inserted: 0, multiDevice: false };
  }
  const senderDeviceId = getCurrentDeviceId();

  // 1. Get all participants of the conversation
  const { data: participants } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', input.conversationId);

  if (!participants?.length) return { inserted: 0, multiDevice: false };
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

  // Multi-device only relevant if at least 1 device beyond the current sender device
  const targets = allDevices.filter(d =>
    !(d.user_id === input.senderUserId && d.device_id === senderDeviceId),
  );
  if (targets.length === 0) return { inserted: 0, multiDevice: false };

  // 3. For each target device:
  //    pre) detect peer SPK rotation → invalidate stale session (avoids
  //         silent decryption failures on the recipient side)
  //    a)   ratchet v3/v4 (existing session, fastest)
  //    b)   X3DH per-device (v1/v2, also caches a session for next time)
  //    c)   deviceWrap (legacy ECDH fallback)
  const rows: Array<Record<string, string>> = [];
  for (const dev of targets) {
    if (!dev.device_public_key) continue;

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
    let encrypted: string | null = await ratchetEncrypt(
      input.senderUserId, senderDeviceId,
      dev.user_id, dev.device_id,
      input.plaintext,
    );
    if (encrypted && !encrypted.startsWith(RATCHET_PREFIX_V4)) {
      encrypted = null;
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

    // (c) Legacy deviceWrap fallback.
    if (!encrypted) {
      try {
        encrypted = await wrapPlaintextForDevice(
          input.plaintext,
          input.senderUserId,
          dev.device_public_key,
          dev.device_id,
        );
      } catch (e) {
        logCryptoException('fanout', e, {
          severity: 'error',
          conversationId: input.conversationId,
          myDeviceId: senderDeviceId,
          peerUserId: dev.user_id,
          peerDeviceId: dev.device_id,
          metadata: { stage: 'all_paths_failed' },
        });
        continue;
      }
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

  if (!rows.length) return { inserted: 0, multiDevice: true };

  const { error } = await supabase
    .from('message_device_copies')
    .upsert(rows as any, { onConflict: 'message_id,recipient_device_id', ignoreDuplicates: true });
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
    return { inserted: 0, multiDevice: true };
  }

  // 4. Tag the parent message as multi-device for downstream readers
  await supabase
    .from('messages')
    .update({ body_kind: 'multi_device' } as any)
    .eq('id', input.messageId);

  return { inserted: rows.length, multiDevice: true };
}

/**
 * Try to read a message via the per-device copy table.
 * Returns plaintext or null. Used by DecryptedMessageBody as fallback when the
 * ratchet decrypt fails (typical case: secondary device).
 */
interface TryReadDeviceCopyOptions {
  requestRetry?: boolean;
}

export async function tryReadDeviceCopy(
  messageId: string,
  expectedSenderUserId?: string,
  options: TryReadDeviceCopyOptions = {},
): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  const shouldRequestRetry = options.requestRetry !== false;
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
        if (shouldRequestRetry && expectedSenderUserId) {
          void requestDeviceCopyRetry({ messageId, senderUserId: expectedSenderUserId });
        }
        return null;
      }
      rows = allCopies as CopyRow[];
      logCryptoError({
        severity: 'info',
        context: 'decrypt',
        errorCode: 'DEVICE_COPY_FALLBACK',
        errorMessage: `Trying ${rows.length} device copies (current device_id has no targeted copy)`,
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
        if (shouldRequestRetry) {
          void requestDeviceCopyRetry({ messageId, senderUserId: expectedSenderUserId });
        }
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
    if (shouldRequestRetry && expectedSenderUserId) {
      void requestDeviceCopyRetry({ messageId, senderUserId: expectedSenderUserId });
    }
    return null;
  } catch (e) {
    logCryptoException('decrypt', e, {
      severity: 'error',
      myDeviceId,
      metadata: { messageId, stage: 'tryReadDeviceCopy' },
    });
    if (shouldRequestRetry && expectedSenderUserId) {
      void requestDeviceCopyRetry({ messageId, senderUserId: expectedSenderUserId });
    }
    return null;
  }
}

/** Attempt decryption of a single device-targeted encrypted row. Returns plaintext or null. */
export async function tryDecryptDeviceTargetedBody(
  row: { encrypted_body: string; sender_user_id: string; sender_device_id: string },
  userId: string,
  myDeviceId: string,
): Promise<string | null> {
  return tryDecryptCopy(row, userId, myDeviceId);
}

/** Attempt decryption of a single device copy row. Returns plaintext or null. */
async function tryDecryptCopy(
  row: { encrypted_body: string; sender_user_id: string; sender_device_id: string },
  userId: string,
  myDeviceId: string,
): Promise<string | null> {
  try {

    // Path 0: cached device-pair ratchet — v3 (legacy KDF chain),
    // v4 (Double Ratchet, no AAD) and **v5** (Double Ratchet + AAD).
    //
    // Bug history: this branch used to only check V3/V4 prefixes. The sender
    // emits V5 envelopes (`x3dh5.`) for every device-pair message, so V5
    // device-copies fell through every decoder and the recipient was stuck
    // displaying ciphertext. This was the root cause of the cross-platform
    // (Windows ↔ iOS) "message stays encrypted" symptom: same-platform pairs
    // often had a conversation-level ratchet session as a side path, while
    // first-contact cross-platform pairs depended exclusively on the device
    // copy path — which did not recognise V5.
    if (
      row.encrypted_body.startsWith(RATCHET_PREFIX_V5) ||
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
