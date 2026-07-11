/**
 * Multi-device fan-out — distributes a sent message as additional, per-device
 * encrypted copies in `message_device_copies`.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';
import { requestDeviceCopyRetry } from './deviceCopyRetryRequest';
import {
  fetchPrekeyBundleForDevice,
  isDevicePrekeyBundleError,
  peekDeviceSignedPrekey,
  x3dhInitiate,
  x3dhRespondForDevice,
} from '@/lib/crypto/x3dh';
import { getOrCreateIdentityKeys, PinUnlockRequiredError, exportPublicKeyRaw } from '@/lib/crypto/keyManager';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import {
  ratchetEncrypt,
  ratchetDecryptWithSession,
  establishDeviceSession,
  getSessionPeerSpkId,
  invalidateDeviceSession,
  RATCHET_PREFIX_V4,
  RATCHET_PREFIX_V5,
} from '@/lib/crypto/deviceRatchet';
import { logCryptoException, logCryptoError } from '@/lib/crypto/errorLogger';
import { listFanoutTargets } from '@/e2ee-session/deviceRegistry';

interface FanoutInput {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  plaintext: string;
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

const X3DH_BOOTSTRAP_PREFIX_V5 = 'x3dh5.init.';
const X3DH_BOOTSTRAP_ENVELOPE_V2 = 'v2';
const X3DH_BOOTSTRAP_AAD_CONTEXT_V2 = 'ForSure-X3DH-v5-Sesame-bootstrap';
const INVALID_DEVICE_STORE_KEY = 'forsure:invalid-device-spk-cache:v1';
const FANOUT_ENCRYPT_CONCURRENCY = 4;
const DEVICE_COPY_ASYNC_FANOUT_GRACE_MS = 3000;
const DEVICE_COPY_SELF_SENT_GRACE_MS = 3000;

type DeviceCopyPrefix = 'x3dh5.init' | 'x3dh5' | 'x3dh4' | 'unsupported';

interface DeviceCopyDecryptAttempt {
  plaintext: string | null;
  attemptedSupportedEnvelope: boolean;
  retryable: boolean;
  reason?: string;
}

type CopyRow = {
  encrypted_body: string;
  sender_user_id: string;
  sender_device_id: string;
  recipient_device_id?: string;
};

type ParentMessageContext = {
  senderUserId?: string;
  createdAtMs?: number;
};

type DeviceCopyGate = {
  defer: boolean;
  reason?: string;
  senderUserId?: string;
  ageMs?: number;
};

function classifyDeviceCopyPrefix(body: string): DeviceCopyPrefix {
  if (body.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return 'x3dh5.init';
  if (body.startsWith(RATCHET_PREFIX_V5)) return 'x3dh5';
  if (body.startsWith(RATCHET_PREFIX_V4)) return 'x3dh4';
  return 'unsupported';
}

interface ParsedX3DHBootstrapV5 {
  version: 'legacy' | 'v2';
  ivB64: string;
  ctB64: string;
  ekB64: string;
  spkId: number;
  opkId?: number;
  senderIdentityKeyB64?: string;
  recipientIdentityKeyB64?: string;
}

interface X3DHBootstrapAADInput {
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  senderIdentityKeyB64: string;
  recipientIdentityKeyB64: string;
  ekB64: string;
  spkId: number;
  opkId?: number;
}

function buildX3DHBootstrapAAD(input: X3DHBootstrapAADInput): Uint8Array {
  // Signal X3DH §3.3 binds AD to IK_A || IK_B; Sesame also binds sessions to
  // UserID/DeviceID mailboxes. JSON keeps the tuple parseable and stable.
  return new hardGlobals.TextEncoder().encode(JSON.stringify({
    context: X3DH_BOOTSTRAP_AAD_CONTEXT_V2,
    sender: {
      userId: input.senderUserId,
      deviceId: input.senderDeviceId,
      identityKey: input.senderIdentityKeyB64,
    },
    recipient: {
      userId: input.recipientUserId,
      deviceId: input.recipientDeviceId,
      identityKey: input.recipientIdentityKeyB64,
    },
    header: {
      ek: input.ekB64,
      spkId: input.spkId,
      opkId: input.opkId ?? null,
    },
  }));
}

function parseX3DHBootstrapV5(payload: string): ParsedX3DHBootstrapV5 | null {
  if (!payload.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return null;
  const parts = payload.slice(X3DH_BOOTSTRAP_PREFIX_V5.length).split('.');

  if (parts[0] === X3DH_BOOTSTRAP_ENVELOPE_V2) {
    if (parts.length !== 8) return null;
    const [, ivB64, ctB64, ekB64, spkIdStr, opkIdStr, senderIdentityKeyB64, recipientIdentityKeyB64] = parts;
    const spkId = parseInt(spkIdStr, 10);
    if (Number.isNaN(spkId)) return null;
    const opkId = opkIdStr === '0' ? undefined : parseInt(opkIdStr, 10);
    if (opkIdStr !== '0' && Number.isNaN(opkId as number)) return null;
    if (!senderIdentityKeyB64 || !recipientIdentityKeyB64) return null;
    return {
      version: 'v2',
      ivB64,
      ctB64,
      ekB64,
      spkId,
      opkId,
      senderIdentityKeyB64,
      recipientIdentityKeyB64,
    };
  }

  // Legacy reader for messages already emitted before the Signal/Sesame AAD
  // hardening. Do not use this shape for new outbound traffic.
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [ivB64, ctB64, ekB64, spkIdStr, opkIdStr] = parts;
  const spkId = parseInt(spkIdStr, 10);
  if (Number.isNaN(spkId)) return null;
  const opkId = opkIdStr !== undefined ? parseInt(opkIdStr, 10) : undefined;
  if (opkIdStr !== undefined && Number.isNaN(opkId as number)) return null;
  return { version: 'legacy', ivB64, ctB64, ekB64, spkId, opkId };
}

async function exportIdentityKeyB64(publicKey: CryptoKey): Promise<string> {
  const raw = await exportPublicKeyRaw(publicKey);
  return bufferToBase64(raw);
}

const KNOWN_INVALID_DEVICE_IDS = new Set<string>([
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '6508eb47a200893f49720fe84b9290b3',
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

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function aesFromSecret(secret: ArrayBuffer): Promise<CryptoKey> {
  return hardCrypto.importKey('raw', secret.slice(0, 32), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function getParentMessageContext(messageId: string): Promise<ParentMessageContext> {
  try {
    const { data } = await supabase
      .from('messages')
      .select('sender_id,created_at')
      .eq('id', messageId)
      .maybeSingle();
    const senderUserId = (data as any)?.sender_id as string | undefined;
    const createdAtRaw = (data as any)?.created_at as string | undefined;
    const createdAtMs = createdAtRaw ? new Date(createdAtRaw).getTime() : undefined;
    return {
      senderUserId,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
    };
  } catch {
    return {};
  }
}

async function getDeviceCopyGate(
  messageId: string,
  currentUserId: string,
  expectedSenderUserId?: string,
): Promise<DeviceCopyGate> {
  const parent = await getParentMessageContext(messageId);
  const senderUserId = expectedSenderUserId ?? parent.senderUserId;
  const ageMs = parent.createdAtMs !== undefined ? Date.now() - parent.createdAtMs : undefined;
  const isFresh = ageMs !== undefined && ageMs >= 0 && ageMs < DEVICE_COPY_ASYNC_FANOUT_GRACE_MS;
  const isFreshOwnMessage = senderUserId === currentUserId && ageMs !== undefined && ageMs >= 0 && ageMs < DEVICE_COPY_SELF_SENT_GRACE_MS;

  if (isFreshOwnMessage) return { defer: true, reason: 'fresh_own_message', senderUserId, ageMs };
  if (isFresh) return { defer: true, reason: 'async_fanout_grace', senderUserId, ageMs };
  return { defer: false, senderUserId, ageMs };
}

async function x3dhWrapForDevice(
  plaintext: string,
  senderUserId: string,
  senderDeviceId: string,
  recipientUserId: string,
  recipientDeviceId: string,
  options: { useOneTimePrekey?: boolean } = {},
): Promise<string | null> {
  if (isKnownInvalidDeviceId(recipientDeviceId)) return null;
  try {
    const bundle = await fetchPrekeyBundleForDevice(recipientUserId, recipientDeviceId, {
      claimOneTimePrekey: options.useOneTimePrekey !== false,
    });
    if (!bundle) {
      logCryptoError({
        severity: 'warning',
        context: 'fanout',
        errorCode: 'DEVICE_PREKEY_BUNDLE_UNAVAILABLE',
        errorMessage: 'Recipient device has no usable v5 bootstrap bundle',
        peerUserId: recipientUserId,
        peerDeviceId: recipientDeviceId,
      });
      return null;
    }

    const myKeys = await getOrCreateIdentityKeys(senderUserId);
    const senderIdentityKeyB64 = await exportIdentityKeyB64(myKeys.publicKey);
    const result = await x3dhInitiate(myKeys, bundle);
    const aes = await aesFromSecret(result.sharedSecret);
    const iv = randomBytes(12);
    const aad = buildX3DHBootstrapAAD({
      senderUserId,
      senderDeviceId,
      recipientUserId,
      recipientDeviceId,
      senderIdentityKeyB64,
      recipientIdentityKeyB64: bundle.identityKey,
      ekB64: result.ephemeralKey,
      spkId: result.usedSPKId,
      opkId: result.usedOTPKId,
    });
    const ct = await hardCrypto.encrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> },
      aes,
      new hardGlobals.TextEncoder().encode(plaintext),
    );

    const parts = [
      X3DH_BOOTSTRAP_PREFIX_V5 + X3DH_BOOTSTRAP_ENVELOPE_V2,
      bufferToBase64(iv.buffer as ArrayBuffer),
      bufferToBase64(ct as ArrayBuffer),
      result.ephemeralKey,
      String(result.usedSPKId),
      result.usedOTPKId === undefined ? '0' : String(result.usedOTPKId),
      senderIdentityKeyB64,
      bundle.identityKey,
    ];

    try {
      await establishDeviceSession(
        senderUserId, senderDeviceId,
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
    if (isDevicePrekeyBundleError(e, 'DEVICE_SPK_SIGNATURE_INVALID')) {
      markInvalidDeviceId(recipientDeviceId);
      logCryptoException('fanout', e, {
        severity: 'error',
        peerUserId: recipientUserId,
        peerDeviceId: recipientDeviceId,
        metadata: { stage: 'x3dh5_bootstrap', action: 'device_quarantined' },
      });
    } else {
      logCryptoException('fanout', e, {
        severity: 'warning',
        peerUserId: recipientUserId,
        peerDeviceId: recipientDeviceId,
        metadata: { stage: 'x3dh5_bootstrap' },
      });
    }
    return null;
  }
}

async function x3dhUnwrapForDevice(
  payload: string,
  recipientUserId: string,
  senderIdentityKeyB64: string | undefined,
  senderUserId: string,
  senderDeviceId: string,
): Promise<string | null> {
  try {
    if (!payload.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return null;

    const parsed = parseX3DHBootstrapV5(payload);
    if (!parsed) return null;

    const myKeys = await getOrCreateIdentityKeys(recipientUserId);
    const myDeviceId = getCurrentDeviceId();
    const senderIdentityForDH = parsed.senderIdentityKeyB64 ?? senderIdentityKeyB64;
    if (!senderIdentityForDH) return null;

    if (parsed.version === 'v2') {
      if (senderIdentityKeyB64 && parsed.senderIdentityKeyB64 !== senderIdentityKeyB64) {
        logCryptoError({
          severity: 'error',
          context: 'decrypt',
          errorCode: 'X3DH_SENDER_IDENTITY_MISMATCH',
          errorMessage: 'Rejected x3dh5.init.v2 envelope whose sender identity does not match the active sender identity',
          myDeviceId,
          peerUserId: senderUserId,
          peerDeviceId: senderDeviceId,
        });
        return null;
      }

      const myIdentityKeyB64 = await exportIdentityKeyB64(myKeys.publicKey);
      if (parsed.recipientIdentityKeyB64 !== myIdentityKeyB64) {
        logCryptoError({
          severity: 'error',
          context: 'decrypt',
          errorCode: 'X3DH_RECIPIENT_IDENTITY_MISMATCH',
          errorMessage: 'Rejected x3dh5.init.v2 envelope targeted at another recipient identity',
          myDeviceId,
          peerUserId: senderUserId,
          peerDeviceId: senderDeviceId,
        });
        return null;
      }
    }

    const { sharedSecret, spkKeyPair } = await x3dhRespondForDevice(myKeys, recipientUserId, myDeviceId, {
      ik: senderIdentityForDH,
      ek: parsed.ekB64,
      spkId: parsed.spkId,
      opkId: parsed.opkId,
    });
    const aes = await aesFromSecret(sharedSecret);
    const aad = parsed.version === 'v2'
      ? buildX3DHBootstrapAAD({
          senderUserId,
          senderDeviceId,
          recipientUserId,
          recipientDeviceId: myDeviceId,
          senderIdentityKeyB64: senderIdentityForDH,
          recipientIdentityKeyB64: parsed.recipientIdentityKeyB64!,
          ekB64: parsed.ekB64,
          spkId: parsed.spkId,
          opkId: parsed.opkId,
        })
      : null;
    const pt = await hardCrypto.decrypt(
      aad
        ? { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.ivB64)), tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> }
        : { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.ivB64)), tagLength: 128 },
      aes,
      base64ToBuffer(parsed.ctB64),
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
          peerSpkId: parsed.spkId,
          selfInitialDhPrivJwk: spkPrivJwk,
          selfInitialDhPubB64: spkPubB64,
        },
      );
    } catch {}

    return new hardGlobals.TextDecoder().decode(pt);
  } catch (e) {
    throw e;
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

  let encrypted: string | null = null;
  try {
    encrypted = await ratchetEncrypt(
      input.senderUserId,
      senderDeviceId,
      input.recipientUserId,
      input.recipientDeviceId,
      input.plaintext,
    );
    if (encrypted && encrypted.startsWith(RATCHET_PREFIX_V5)) {
      return { encryptedBody: encrypted, senderDeviceId };
    }
    encrypted = null;
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

  // Sesame fast path: an existing Double Ratchet session is used without a
  // pre-send SPK network round-trip. Only when no usable ratchet session exists
  // do we check SPK freshness and fall back to X3DH bootstrap.
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
        logCryptoError({
          severity: 'warning',
          context: 'fanout',
          errorCode: 'DEVICE_PREKEY_BUNDLE_UNAVAILABLE',
          errorMessage: 'Skipping SPK freshness check because peer v5 bundle is unavailable',
          conversationId: input.conversationId,
          myDeviceId: senderDeviceId,
          peerUserId: input.recipientUserId,
          peerDeviceId: input.recipientDeviceId,
          metadata: { cachedSpkId },
        });
      } else if (spk.signedPrekeyId !== cachedSpkId) {
        await invalidateDeviceSession(
          input.senderUserId,
          senderDeviceId,
          input.recipientUserId,
          input.recipientDeviceId,
        );
      }
    }
  } catch (e) {
    if (isDevicePrekeyBundleError(e, 'DEVICE_SPK_SIGNATURE_INVALID')) {
      markInvalidDeviceId(input.recipientDeviceId);
      logCryptoException('fanout', e, {
        severity: 'error',
        conversationId: input.conversationId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
        metadata: { stage: 'spk_rotation_check', action: 'device_quarantined' },
      });
      return null;
    }
    logCryptoException('fanout', e, {
      severity: 'warning',
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
      metadata: { stage: 'spk_rotation_check' },
    });
  }

  encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, senderDeviceId, input.recipientUserId, input.recipientDeviceId, { useOneTimePrekey: input.useOneTimePrekey });

  if (!encrypted) {
    logCryptoError({
      severity: 'warning',
      context: 'fanout',
      errorCode: 'E_FANOUT_NO_V5_PATH',
      errorMessage: 'No v5 ratchet/bootstrap path for recipient device',
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
      metadata: { stage: 'all_paths_failed' },
    });
    return null;
  }

  return { encryptedBody: encrypted, senderDeviceId };
}

export interface FanoutCopyRow {
  message_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  sender_user_id: string;
  sender_device_id: string;
  encrypted_body: string;
}

/**
 * Encrypts the plaintext for every recipient device WITHOUT inserting into the
 * database. Returns the rows ready to be persisted (either via direct insert or
 * via the transactional `send_message_with_device_copies` RPC alongside the
 * parent message row).
 *
 * The current sender device is deliberately excluded. Its durable recovery
 * path is the account-wrapped encrypted archive, which survives a complete
 * IndexedDB purge. Other devices belonging to the sender remain fan-out
 * targets so cross-device self history continues to work.
 *
 * Pass a synthetic `messageId` (e.g. the to-be-assigned UUID) — the same id
 * must then be reused when persisting the `messages` row.
 */
export async function buildFanoutCopies(input: FanoutInput): Promise<{ rows: FanoutCopyRow[]; hasTargets: boolean }> {
  if (isDeviceIdTemporary()) return { rows: [], hasTargets: false };
  const senderDeviceId = getCurrentDeviceId();

  const { data: participants } = await supabase.from('conversation_participants').select('user_id').eq('conversation_id', input.conversationId);
  if (!participants?.length) return { rows: [], hasTargets: false };
  const userIds = participants.map(p => p.user_id);

  const targets = (await listFanoutTargets(input.senderUserId, userIds, { verifyPrekeys: false }))
    .filter(d =>
      !(d.userId === input.senderUserId && d.deviceId === senderDeviceId) &&
      !isKnownInvalidDeviceId(d.deviceId),
    );
  if (targets.length === 0) return { rows: [], hasTargets: false };

  const rowResults = await mapWithConcurrency(targets, FANOUT_ENCRYPT_CONCURRENCY, async (dev) => {
    if (!dev.devicePublicKey || isKnownInvalidDeviceId(dev.deviceId)) return null;

    try {
      const encrypted = await encryptPlaintextForDeviceTarget({
        conversationId: input.conversationId,
        senderUserId: input.senderUserId,
        senderDeviceId,
        recipientUserId: dev.userId,
        recipientDeviceId: dev.deviceId,
        recipientDevicePublicKey: dev.devicePublicKey,
        plaintext: input.plaintext,
      });
      if (!encrypted) return null;
      return {
        message_id: input.messageId,
        recipient_user_id: dev.userId,
        recipient_device_id: dev.deviceId,
        sender_user_id: input.senderUserId,
        sender_device_id: encrypted.senderDeviceId,
        encrypted_body: encrypted.encryptedBody,
      } as FanoutCopyRow;
    } catch (e) {
      logCryptoException('fanout', e, {
        severity: 'warning',
        conversationId: input.conversationId,
        myDeviceId: senderDeviceId,
        peerUserId: dev.userId,
        peerDeviceId: dev.deviceId,
        metadata: { stage: 'fanout_target_encrypt' },
      });
      return null;
    }
  });

  const rows = rowResults.filter(Boolean) as FanoutCopyRow[];
  return { rows, hasTargets: true };
}

export async function insertFanoutCopyRows(
  input: FanoutInput,
  rows: FanoutCopyRow[],
): Promise<{ inserted: number; multiDevice: boolean }> {
  if (!rows.length) return { inserted: 0, multiDevice: true };

  const { error } = await supabase.from('message_device_copies').upsert(rows as any, { onConflict: 'message_id,recipient_device_id', ignoreDuplicates: true });
  if (error) {
    logCryptoError({ severity: 'error', context: 'fanout', errorCode: 'E_FANOUT_INSERT', errorMessage: error.message, conversationId: input.conversationId, myDeviceId: getCurrentDeviceId(), metadata: { rows: rows.length } });
    return { inserted: 0, multiDevice: true };
  }

  await supabase.from('messages').update({ body_kind: 'multi_device' } as any).eq('id', input.messageId);
  return { inserted: rows.length, multiDevice: true };
}

export async function fanoutMessageCopies(input: FanoutInput): Promise<{ inserted: number; multiDevice: boolean }> {
  const { rows, hasTargets } = await buildFanoutCopies(input);
  if (!hasTargets) return { inserted: 0, multiDevice: false };
  return insertFanoutCopyRows(input, rows);
}

interface TryReadDeviceCopyOptions { requestRetry?: boolean; }

export async function tryReadDeviceCopy(messageId: string, expectedSenderUserId?: string, options: TryReadDeviceCopyOptions = {}): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const shouldRequestRetry = options.requestRetry !== false;

  try {
    let rows: CopyRow[] = [];
    const { data: targeted } = await supabase.rpc('get_device_copy_for_message', { p_message_id: messageId, p_device_id: myDeviceId });
    if (targeted && targeted.length > 0) {
      rows = (targeted as CopyRow[]).map(r => ({ ...r, recipient_device_id: r.recipient_device_id ?? myDeviceId }));
    } else {
      const { data: allCopies } = await supabase.rpc('get_device_copies_for_user', { p_message_id: messageId });
      if (!allCopies || allCopies.length === 0) {
        const gate = await getDeviceCopyGate(messageId, user.id, expectedSenderUserId);
        if (gate.defer) {
          logCryptoError({
            severity: 'info',
            context: 'decrypt',
            errorCode: 'DEVICE_COPY_ABSENT_GRACE',
            errorMessage: 'Device copy absent but still inside async fanout grace window; deferring repair',
            myDeviceId,
            peerUserId: gate.senderUserId,
            metadata: { messageId, reason: gate.reason, ageMs: gate.ageMs },
          });
          return null;
        }

        // Missing copies are a message-delivery problem, not a device-validity
        // problem. A valid local device must not re-publish itself just because
        // an old message lacks a targeted copy. Ask the sender/refanout path to
        // repair the message only.
        if (shouldRequestRetry) {
          const senderUserId = gate.senderUserId ?? (await (async () => {
            try {
              const { data } = await supabase
                .from('messages')
                .select('sender_id')
                .eq('id', messageId)
                .maybeSingle();
              return (data as any)?.sender_id as string | undefined;
            } catch { return undefined; }
          })());
          if (senderUserId) {
            logCryptoError({
              severity: 'warning',
              context: 'decrypt',
              errorCode: 'DEVICE_COPY_ABSENT_REQUESTING_REFANOUT',
              errorMessage: 'No device copy exists for this user after grace window; requesting message refanout only',
              myDeviceId,
              peerUserId: senderUserId,
              metadata: { messageId, ageMs: gate.ageMs },
            });
            await requestDeviceCopyRetry({ messageId, senderUserId });
          }
        }
        return null;
      }
      const fallbackRows = filterCopyRowsByExpectedSender(allCopies as CopyRow[], expectedSenderUserId);
      const firstSender = fallbackRows[0] ?? (allCopies as CopyRow[])[0];
      const gate = await getDeviceCopyGate(messageId, user.id, expectedSenderUserId ?? firstSender?.sender_user_id);
      if (gate.defer) {
        logCryptoError({
          severity: 'info',
          context: 'decrypt',
          errorCode: 'DEVICE_COPY_TARGET_MISSING_GRACE',
          errorMessage: 'Device copies exist but current target copy may still be async; deferring repair',
          myDeviceId,
          peerUserId: gate.senderUserId,
          peerDeviceId: firstSender?.sender_device_id,
          metadata: {
            messageId,
            candidates: (allCopies as CopyRow[]).length,
            expectedSenderUserId,
            reason: gate.reason,
            ageMs: gate.ageMs,
          },
        });
        return null;
      }

      logCryptoError({
        severity: 'info',
        context: 'decrypt',
        errorCode: 'DEVICE_COPY_TARGET_MISSING',
        errorMessage: 'No encrypted device copy targets the current device after grace window; requesting message refanout only',
        myDeviceId,
        peerUserId: firstSender?.sender_user_id,
        peerDeviceId: firstSender?.sender_device_id,
        metadata: {
          messageId,
          candidates: (allCopies as CopyRow[]).length,
          expectedSenderUserId,
          retryEnabled: shouldRequestRetry,
          ageMs: gate.ageMs,
        },
      });
      if (shouldRequestRetry) {
        const retrySenders = new Map<string, string | null>();
        for (const row of fallbackRows) {
          if (!retrySenders.has(row.sender_user_id)) {
            retrySenders.set(row.sender_user_id, row.sender_device_id);
          }
        }
        await Promise.all(
          [...retrySenders.entries()].map(([senderUserId, senderDeviceId]) =>
            requestDeviceCopyRetry({ messageId, senderUserId, senderDeviceId }),
          ),
        );
      }
      return null;
    }

    if (expectedSenderUserId) {
      const before = rows.length;
      rows = filterCopyRowsByExpectedSender(rows, expectedSenderUserId);
      if (before !== rows.length) logCryptoError({ severity: 'warning', context: 'decrypt', errorCode: 'DEVICE_COPY_SENDER_MISMATCH', errorMessage: 'Rejected device copies whose sender does not match parent message', myDeviceId, metadata: { messageId, expectedSenderUserId, rejected: before - rows.length } });
      if (rows.length === 0) {
        return null;
      }
    }

    const retrySenders = new Map<string, string | null>();
    const failedAttempts: Array<Record<string, string>> = [];
    for (const row of rows) {
      const targetDeviceId = row.recipient_device_id || myDeviceId;
      const attempt = await tryDecryptCopy(row, user.id, targetDeviceId);
      if (attempt.plaintext !== null) return attempt.plaintext;
      if (!attempt.attemptedSupportedEnvelope) continue;

      failedAttempts.push({
        senderUserId: row.sender_user_id,
        senderDeviceId: row.sender_device_id,
        targetDeviceId,
        prefix: classifyDeviceCopyPrefix(row.encrypted_body),
        reason: attempt.reason ?? 'decrypt_returned_null',
      });
      if (attempt.retryable && !retrySenders.has(row.sender_user_id)) {
        retrySenders.set(row.sender_user_id, row.sender_device_id);
      }
    }

    if (failedAttempts.length > 0) {
      const firstFailure = failedAttempts[0];
      logCryptoError({
        severity: 'warning',
        context: 'decrypt',
        errorCode: 'DEVICE_COPY_DECRYPT_FAILED',
        errorMessage: 'Supported device-copy envelopes were present but none decrypted',
        myDeviceId,
        peerUserId: firstFailure?.senderUserId,
        peerDeviceId: firstFailure?.senderDeviceId,
        metadata: {
          messageId,
          candidates: rows.length,
          failed: failedAttempts.slice(0, 8),
          retryEligibleSenders: [...retrySenders.keys()],
          retryEnabled: shouldRequestRetry,
        },
      });
    }

    if (shouldRequestRetry && retrySenders.size > 0) {
      await Promise.all(
        [...retrySenders.entries()].map(([senderUserId, senderDeviceId]) =>
          requestDeviceCopyRetry({ messageId, senderUserId, senderDeviceId }),
        ),
      );
    }

    return null;
  } catch (e) {
    logCryptoException('decrypt', e, { severity: 'error', myDeviceId, metadata: { messageId, stage: 'tryReadDeviceCopy' } });
    return null;
  }
}

function filterCopyRowsByExpectedSender(rows: CopyRow[], expectedSenderUserId?: string): CopyRow[] {
  if (!expectedSenderUserId) return rows;
  return rows.filter(row => row.sender_user_id === expectedSenderUserId);
}

export async function tryDecryptDeviceTargetedBody(row: { encrypted_body: string; sender_user_id: string; sender_device_id: string }, userId: string, myDeviceId: string): Promise<string | null> {
  return (await tryDecryptCopy(row, userId, myDeviceId)).plaintext;
}

async function tryDecryptCopy(row: { encrypted_body: string; sender_user_id: string; sender_device_id: string }, userId: string, myDeviceId: string): Promise<DeviceCopyDecryptAttempt> {
  const prefix = classifyDeviceCopyPrefix(row.encrypted_body);
  try {
    if (prefix === 'x3dh5.init') {
      const parsed = parseX3DHBootstrapV5(row.encrypted_body);
      const { data: senderPub } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
      if (!senderPub?.identity_key && parsed?.version !== 'v2') {
        return { plaintext: null, attemptedSupportedEnvelope: true, retryable: false, reason: 'sender_identity_key_missing' };
      }
      const plaintext = await x3dhUnwrapForDevice(row.encrypted_body, userId, senderPub?.identity_key, row.sender_user_id, row.sender_device_id);
      return {
        plaintext,
        attemptedSupportedEnvelope: true,
        retryable: plaintext === null,
        reason: plaintext === null ? 'x3dh5_init_decrypt_returned_null' : undefined,
      };
    }

    if (prefix === 'x3dh5' || prefix === 'x3dh4') {
      const pt = await ratchetDecryptWithSession(userId, myDeviceId, row.sender_user_id, row.sender_device_id, row.encrypted_body);
      if (pt === null) {
        await invalidateDeviceSession(userId, myDeviceId, row.sender_user_id, row.sender_device_id).catch(() => {});
      }
      return {
        plaintext: pt ?? null,
        attemptedSupportedEnvelope: true,
        retryable: pt === null,
        reason: pt === null ? `${prefix}_decrypt_returned_null` : undefined,
      };
    }

    return { plaintext: null, attemptedSupportedEnvelope: false, retryable: false, reason: 'unsupported_prefix' };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      plaintext: null,
      attemptedSupportedEnvelope: prefix !== 'unsupported',
      retryable: prefix !== 'unsupported',
      reason,
    };
  }
}
