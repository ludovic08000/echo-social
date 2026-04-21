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
import { getCurrentDeviceId } from './currentDevice';
import { wrapPlaintextForDevice, unwrapPlaintextForDevice } from './deviceWrap';
import {
  fetchPrekeyBundleForDevice,
  x3dhInitiate,
  x3dhRespond,
  x3dhRespondForDevice,
} from '@/lib/crypto/x3dh';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManager';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';

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
    return parts.join('.');
  } catch (e) {
    console.warn('[FANOUT] X3DH wrap failed, will fallback:', e);
    return null;
  }
}

async function x3dhUnwrapForDevice(
  payload: string,
  recipientUserId: string,
  senderIdentityKeyB64: string,
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
    const { sharedSecret } = await x3dhRespondForDevice(myKeys, recipientUserId, myDeviceId, {
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
    return new hardGlobals.TextDecoder().decode(pt);
  } catch (e) {
    console.warn('[FANOUT] X3DH unwrap failed:', e);
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function fanoutMessageCopies(input: FanoutInput): Promise<{ inserted: number; multiDevice: boolean }> {
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

  // 3. For each target device: try X3DH first, then deviceWrap fallback
  const rows: Array<Record<string, string>> = [];
  for (const dev of targets) {
    if (!dev.device_public_key) continue;

    let encrypted: string | null = await x3dhWrapForDevice(
      input.plaintext,
      input.senderUserId,
      dev.user_id,
      dev.device_id,
    );

    if (!encrypted) {
      try {
        encrypted = await wrapPlaintextForDevice(
          input.plaintext,
          input.senderUserId,
          dev.device_public_key,
          dev.device_id,
        );
      } catch (e) {
        console.warn('[FANOUT] both X3DH and deviceWrap failed for device', dev.device_id, e);
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

  const { error } = await supabase.from('message_device_copies').insert(rows as any);
  if (error) {
    console.warn('[FANOUT] insert failed', error.message);
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
export async function tryReadDeviceCopy(messageId: string): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  try {
    const { data } = await supabase.rpc('get_device_copy_for_message', {
      p_message_id: messageId,
      p_device_id: myDeviceId,
    });
    if (!data || data.length === 0) return null;
    const row = data[0] as { encrypted_body: string; sender_user_id: string; sender_device_id: string };

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    // Path 1: X3DH-wrapped envelope (v1 = no OPK, v2 = with OPK)
    if (row.encrypted_body.startsWith(X3DH_PREFIX_V1) || row.encrypted_body.startsWith(X3DH_PREFIX_V2)) {
      const { data: senderPub } = await supabase
        .from('user_public_keys')
        .select('identity_key')
        .eq('user_id', row.sender_user_id)
        .eq('is_active', true)
        .maybeSingle();
      if (!senderPub?.identity_key) return null;
      const pt = await x3dhUnwrapForDevice(row.encrypted_body, user.id, senderPub.identity_key);
      if (pt !== null) return pt;
      // fall through to legacy attempt for safety
    }

    // Path 2: legacy deviceWrap (ECDH on sender identity ↔ recipient device key)
    const { data: senderDevices } = await supabase.rpc('list_active_devices_for_user', {
      p_user_id: row.sender_user_id,
    });
    const senderDev = (senderDevices || []).find((d: any) => d.device_id === row.sender_device_id);
    if (!senderDev?.device_public_key) return null;

    return await unwrapPlaintextForDevice(
      row.encrypted_body,
      user.id,
      senderDev.device_public_key,
      myDeviceId,
    );
  } catch (e) {
    console.warn('[FANOUT] device-copy read failed', e);
    return null;
  }
}
