/**
 * Multi-device fan-out — distributes a sent message as additional, per-device
 * encrypted copies in `message_device_copies`.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';
import { wrapPlaintextForDevice, unwrapPlaintextForDevice } from './deviceWrap';
import { requestDeviceCopyRetry } from './deviceCopyRetryRequest';
import {
  fetchPrekeyBundleForDevice,
  peekDeviceSignedPrekey,
  x3dhInitiate,
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
  RATCHET_PREFIX_V5,
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
  forceFreshSession?: boolean;
  /** @deprecated Kept for type-compat; ignored. v5-only outbound. */
  forceX3DH?: boolean;
  useOneTimePrekey?: boolean;
}

const X3DH_PREFIX_V1 = 'x3dh1.';
const X3DH_PREFIX_V2 = 'x3dh2.';
const INVALID_DEVICE_STORE_KEY = 'forsure:invalid-device-spk-cache:v1';

const KNOWN_INVALID_DEVICE_IDS = new Set<string>([
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8',
]);

// Device IDs that were previously blocklisted by mistake — purge from any
// persisted local cache so live iOS / web installs stop being skipped during
// fan-out. Safe to extend; entries here are *removed* from the user's cache.
const FORMERLY_INVALID_DEVICE_IDS = new Set<string>([
  '84aaa52143235807214bf3aa161dd03a',
]);

try {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(INVALID_DEVICE_STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const cleaned = arr.filter((id: unknown) => typeof id === 'string' && !FORMERLY_INVALID_DEVICE_IDS.has(id));
        if (cleaned.length !== arr.length) {
          localStorage.setItem(INVALID_DEVICE_STORE_KEY, JSON.stringify(cleaned));
        }
      }
    }
  }
} catch {}

function loadInvalidDeviceCache(): Set<string> {
  const out = new Set(KNOWN_INVALID_DEVICE_IDS);
  try {
    const raw = localStorage.getItem(INVALID_DEVICE_STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) arr.forEach((id) => typeof id === 'string' && out.add(id));
  } catch {}
  return out;
}

function markInvalidDeviceId(deviceId: string | null | undefined): void {
  if (!deviceId) return;
  try {
    const set = loadInvalidDeviceCache();
    set.add(deviceId);
    localStorage.setItem(INVALID_DEVICE_STORE_KEY, JSON.stringify([...set].slice(-200)));
  } catch {}
}

function isKnownInvalidDeviceId(deviceId: string | null | undefined): boolean {
  return !!deviceId && loadInvalidDeviceCache().has(deviceId);
}

async function aesFromSecret(secret: ArrayBuffer): Promise<CryptoKey> {
  return hardCrypto.importKey('raw', secret.slice(0, 32), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function x3dhWrapForDevice(
  plaintext: string,
  senderUserId: string,
  recipientUserId: string,
  recipientDeviceId: string,
  options: { useOneTimePrekey?: boolean } = {},
): Promise<string | null> {
  if (isKnownInvalidDeviceId(recipientDeviceId)) return null;
  try {
    const bundle = await fetchPrekeyBundleForDevice(recipientUserId, recipientDeviceId);
    if (!bundle) {
      markInvalidDeviceId(recipientDeviceId);
      return null;
    }
    if (options.useOneTimePrekey === false) {
      delete bundle.oneTimePrekey;
      delete bundle.oneTimePrekeyId;
    }

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
    } catch {}

    return parts.join('.');
  } catch (e) {
    if (e instanceof PinUnlockRequiredError || String(e).toLowerCase().includes('pin unlock required')) {
      throw e;
    }
    markInvalidDeviceId(recipientDeviceId);
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
    } catch {}

    return new hardGlobals.TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function encryptPlaintextForDeviceTarget(
  input: DeviceEncryptTargetInput,
): Promise<{ encryptedBody: string; senderDeviceId: string } | null> {
  if (!input.recipientDevicePublicKey) return null;
  if (isDeviceIdTemporary()) return null;
  if (isKnownInvalidDeviceId(input.recipientDeviceId)) return null;

  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();

  if (input.forceFreshSession) {
    await invalidateDeviceSession(input.senderUserId, senderDeviceId, input.recipientUserId, input.recipientDeviceId).catch(() => {});
  }

  try {
    const cachedSpkId = await getSessionPeerSpkId(
      input.senderUserId,
      senderDeviceId,
      input.recipientUserId,
      input.recipientDeviceId,
    );
    if (cachedSpkId !== null) {
      const spk = await peekDeviceSignedPrekey(input.recipientUserId, input.recipientDeviceId);
      if (!spk) {
        markInvalidDeviceId(input.recipientDeviceId);
        return null;
      }
      if (spk.signedPrekeyId !== cachedSpkId) {
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
    if (encrypted && !encrypted.startsWith(RATCHET_PREFIX_V5) && !encrypted.startsWith(RATCHET_PREFIX_V4)) {
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

  if (!encrypted) encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, input.recipientUserId, input.recipientDeviceId, { useOneTimePrekey: input.useOneTimePrekey });


  if (!encrypted) {
    try {
      encrypted = await wrapPlaintextForDevice(input.plaintext, input.senderUserId, input.recipientDevicePublicKey, input.recipientDeviceId);
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
  if (isDeviceIdTemporary()) return { inserted: 0, multiDevice: false };
  const senderDeviceId = getCurrentDeviceId();

  const { data: participants } = await supabase.from('conversation_participants').select('user_id').eq('conversation_id', input.conversationId);
  if (!participants?.length) return { inserted: 0, multiDevice: false };
  const userIds = participants.map(p => p.user_id);

  const deviceLists = await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.rpc('list_active_devices_for_user', { p_user_id: uid });
        return (data || []).map((d: any) => ({ user_id: uid, device_id: d.device_id as string, device_public_key: d.device_public_key as string })) as ActiveDevice[];
      } catch {
        return [] as ActiveDevice[];
      }
    }),
  );

  const targets = deviceLists.flat().filter(d =>
    !(d.user_id === input.senderUserId && d.device_id === senderDeviceId) &&
    !isKnownInvalidDeviceId(d.device_id),
  );
  if (targets.length === 0) return { inserted: 0, multiDevice: false };

  const rows: Array<Record<string, string>> = [];
  for (const dev of targets) {
    if (!dev.device_public_key || isKnownInvalidDeviceId(dev.device_id)) continue;

    try {
      const cachedSpkId = await getSessionPeerSpkId(input.senderUserId, senderDeviceId, dev.user_id, dev.device_id);
      if (cachedSpkId !== null) {
        const spk = await peekDeviceSignedPrekey(dev.user_id, dev.device_id);
        if (!spk) {
          markInvalidDeviceId(dev.device_id);
          continue;
        }
        if (spk.signedPrekeyId !== cachedSpkId) {
          await invalidateDeviceSession(input.senderUserId, senderDeviceId, dev.user_id, dev.device_id);
        }
      }
    } catch (e) {
      logCryptoException('fanout', e, { severity: 'warning', conversationId: input.conversationId, myDeviceId: senderDeviceId, peerUserId: dev.user_id, peerDeviceId: dev.device_id, metadata: { stage: 'spk_rotation_check' } });
    }

    let encrypted: string | null = await ratchetEncrypt(input.senderUserId, senderDeviceId, dev.user_id, dev.device_id, input.plaintext);
    if (encrypted && !encrypted.startsWith(RATCHET_PREFIX_V5) && !encrypted.startsWith(RATCHET_PREFIX_V4)) encrypted = null;
    if (!encrypted) encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, dev.user_id, dev.device_id);
    if (!encrypted) {
      try {
        encrypted = await wrapPlaintextForDevice(input.plaintext, input.senderUserId, dev.device_public_key, dev.device_id);
      } catch (e) {
        logCryptoException('fanout', e, { severity: 'error', conversationId: input.conversationId, myDeviceId: senderDeviceId, peerUserId: dev.user_id, peerDeviceId: dev.device_id, metadata: { stage: 'all_paths_failed' } });
        continue;
      }
    }

    rows.push({ message_id: input.messageId, recipient_user_id: dev.user_id, recipient_device_id: dev.device_id, sender_user_id: input.senderUserId, sender_device_id: senderDeviceId, encrypted_body: encrypted });
  }

  if (!rows.length) return { inserted: 0, multiDevice: true };

  const { error } = await supabase.from('message_device_copies').upsert(rows as any, { onConflict: 'message_id,recipient_device_id', ignoreDuplicates: true });
  if (error) {
    logCryptoError({ severity: 'error', context: 'fanout', errorCode: 'E_FANOUT_INSERT', errorMessage: error.message, conversationId: input.conversationId, myDeviceId: senderDeviceId, metadata: { rows: rows.length } });
    return { inserted: 0, multiDevice: true };
  }

  await supabase.from('messages').update({ body_kind: 'multi_device' } as any).eq('id', input.messageId);
  return { inserted: rows.length, multiDevice: true };
}

interface TryReadDeviceCopyOptions { requestRetry?: boolean; }

export async function tryReadDeviceCopy(messageId: string, expectedSenderUserId?: string, options: TryReadDeviceCopyOptions = {}): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  const shouldRequestRetry = options.requestRetry !== false;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  try {
    type CopyRow = { encrypted_body: string; sender_user_id: string; sender_device_id: string; recipient_device_id?: string };
    let rows: CopyRow[] = [];
    const { data: targeted } = await supabase.rpc('get_device_copy_for_message', { p_message_id: messageId, p_device_id: myDeviceId });
    if (targeted && targeted.length > 0) {
      rows = (targeted as CopyRow[]).map(r => ({ ...r, recipient_device_id: r.recipient_device_id ?? myDeviceId }));
    } else {
      const { data: allCopies } = await supabase.rpc('get_device_copies_for_user', { p_message_id: messageId });
      if (!allCopies || allCopies.length === 0) {
        if (shouldRequestRetry && expectedSenderUserId) void requestDeviceCopyRetry({ messageId, senderUserId: expectedSenderUserId });
        return null;
      }
      rows = allCopies as CopyRow[];
      logCryptoError({ severity: 'info', context: 'decrypt', errorCode: 'DEVICE_COPY_FALLBACK', errorMessage: `Trying ${rows.length} device copies (current device_id has no targeted copy)`, myDeviceId, metadata: { messageId, candidates: rows.length } });
    }

    if (expectedSenderUserId) {
      const before = rows.length;
      rows = rows.filter(row => row.sender_user_id === expectedSenderUserId);
      if (before !== rows.length) logCryptoError({ severity: 'warning', context: 'decrypt', errorCode: 'DEVICE_COPY_SENDER_MISMATCH', errorMessage: 'Rejected device copies whose sender does not match parent message', myDeviceId, metadata: { messageId, expectedSenderUserId, rejected: before - rows.length } });
      if (rows.length === 0) {
        if (shouldRequestRetry) void requestDeviceCopyRetry({ messageId, senderUserId: expectedSenderUserId });
        return null;
      }
    }

    for (const row of rows) {
      const targetDeviceId = row.recipient_device_id || myDeviceId;
      const pt = await tryDecryptCopy(row, user.id, targetDeviceId);
      if (pt !== null) return pt;
    }
    if (shouldRequestRetry && expectedSenderUserId) void requestDeviceCopyRetry({ messageId, senderUserId: expectedSenderUserId });
    return null;
  } catch (e) {
    logCryptoException('decrypt', e, { severity: 'error', myDeviceId, metadata: { messageId, stage: 'tryReadDeviceCopy' } });
    if (shouldRequestRetry && expectedSenderUserId) void requestDeviceCopyRetry({ messageId, senderUserId: expectedSenderUserId });
    return null;
  }
}

export async function tryDecryptDeviceTargetedBody(row: { encrypted_body: string; sender_user_id: string; sender_device_id: string }, userId: string, myDeviceId: string): Promise<string | null> {
  return tryDecryptCopy(row, userId, myDeviceId);
}

async function tryDecryptCopy(row: { encrypted_body: string; sender_user_id: string; sender_device_id: string }, userId: string, myDeviceId: string): Promise<string | null> {
  try {
    if (row.encrypted_body.startsWith(RATCHET_PREFIX_V5) || row.encrypted_body.startsWith(RATCHET_PREFIX_V4) || row.encrypted_body.startsWith(RATCHET_PREFIX_V3)) {
      const pt = await ratchetDecryptWithSession(userId, myDeviceId, row.sender_user_id, row.sender_device_id, row.encrypted_body);
      return pt ?? null;
    }

    if (row.encrypted_body.startsWith(X3DH_PREFIX_V1) || row.encrypted_body.startsWith(X3DH_PREFIX_V2)) {
      const { data: senderPub } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
      if (!senderPub?.identity_key) return null;
      const pt = await x3dhUnwrapForDevice(row.encrypted_body, userId, senderPub.identity_key, row.sender_user_id, row.sender_device_id);
      if (pt !== null) return pt;
    }

    const { data: senderDevices } = await supabase.rpc('list_active_devices_for_user', { p_user_id: row.sender_user_id });
    const senderDev = (senderDevices || []).find((d: any) => d.device_id === row.sender_device_id);
    if (!senderDev?.device_public_key) return null;

    const { data: senderPubLegacy } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
    return await unwrapPlaintextForDevice(row.encrypted_body, userId, senderDev.device_public_key, myDeviceId, senderPubLegacy?.identity_key ?? null);
  } catch {
    return null;
  }
}
