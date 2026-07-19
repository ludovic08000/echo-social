/**
 * Multi-device fan-out — distributes a sent message as additional, per-device
 * encrypted copies in `message_device_copies`.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';
import {
  isDevicePrekeyBundleError,
  peekDeviceSignedPrekey,
} from '@/lib/crypto/x3dh';
import { PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import {
  ratchetEncrypt,
  ratchetDecryptWithSession,
  getSessionPeerSpkId,
  invalidateDeviceSession,
  RATCHET_PREFIX_V5,
} from '@/lib/crypto/deviceRatchet';
import { logCryptoException, logCryptoError } from '@/lib/crypto/errorLogger';
import { getCachedAuthUserId } from '@/lib/crypto/peerKeyCache';
import { resolveFanoutRoute } from '@/lib/messaging/fanoutRouteCache';
import { captureFanoutSessionBeforeMutation } from '@/lib/messaging/fanoutSessionTransaction';
import {
  acknowledgeInitiatingSessionFromRatchetPayload,
  createRepeatablePreKeyEnvelope,
  isRepeatablePreKeyEnvelope,
  prepareInitiatingSessionForSend,
  restartExpiredInitiatingSession,
  unwrapRepeatablePreKeyEnvelope,
  wrapRatchetForInitiatingSession,
} from '@/lib/messaging/repeatablePreKeyEnvelope';
import { runDeviceSessionJob } from '@/lib/crypto/deviceSessionQueue';

interface FanoutInput {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  plaintext: string;
}

interface DeviceEncryptTargetInput {
  messageId?: string;
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

const INVALID_DEVICE_STORE_KEY = 'forsure:invalid-device-spk-cache:v1';
const FANOUT_ENCRYPT_CONCURRENCY = 2;

type DeviceCopyPrefix = 'x3dh5.init.v3' | 'x3dh5' | 'unsupported';

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

function classifyDeviceCopyPrefix(body: string): DeviceCopyPrefix {
  if (isRepeatablePreKeyEnvelope(body)) return 'x3dh5.init.v3';
  if (body.startsWith(RATCHET_PREFIX_V5)) return 'x3dh5';
  return 'unsupported';
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
} catch {
  // localStorage can be unavailable in private/restricted browser contexts.
}

function loadInvalidDeviceCache(): Set<string> {
  const out = new Set(KNOWN_INVALID_DEVICE_IDS);
  try {
    const raw = localStorage.getItem(INVALID_DEVICE_STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) arr.forEach((id) => typeof id === 'string' && out.add(id));
  } catch {
    // Treat an unreadable cache as empty; server-verified routes remain authoritative.
  }
  return out;
}

function markInvalidDeviceId(deviceId: string | null | undefined): void {
  if (!deviceId) return;
  try {
    const set = loadInvalidDeviceCache();
    set.add(deviceId);
    localStorage.setItem(INVALID_DEVICE_STORE_KEY, JSON.stringify([...set].slice(-200)));
  } catch {
    // Cache persistence is best-effort and must never block encrypted delivery.
  }
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
    return await createRepeatablePreKeyEnvelope({
      plaintext,
      senderUserId,
      senderDeviceId,
      recipientUserId,
      recipientDeviceId,
      useOneTimePrekey: options.useOneTimePrekey,
    });
  } catch (error) {
    if (error instanceof PinUnlockRequiredError || String(error).toLowerCase().includes('pin unlock required')) {
      throw error;
    }
    if (isDevicePrekeyBundleError(error, 'DEVICE_SPK_SIGNATURE_INVALID')) {
      markInvalidDeviceId(recipientDeviceId);
      logCryptoException('fanout', error, {
        severity: 'error',
        peerUserId: recipientUserId,
        peerDeviceId: recipientDeviceId,
        metadata: { stage: 'x3dh5_init_v3', action: 'device_quarantined' },
      });
    } else {
      logCryptoException('fanout', error, {
        severity: 'warning',
        peerUserId: recipientUserId,
        peerDeviceId: recipientDeviceId,
        metadata: { stage: 'x3dh5_init_v3' },
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
  if (!isRepeatablePreKeyEnvelope(payload)) return null;
  return unwrapRepeatablePreKeyEnvelope({
    payload,
    recipientUserId,
    recipientDeviceId: getCurrentDeviceId(),
    senderUserId,
    senderDeviceId,
    expectedSenderIdentityKeyB64: senderIdentityKeyB64,
  });
}

export async function encryptPlaintextForDeviceTarget(
  input: DeviceEncryptTargetInput,
): Promise<{ encryptedBody: string; senderDeviceId: string } | null> {
  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();
  const key = `${input.senderUserId}::${senderDeviceId}::${input.recipientUserId}::${input.recipientDeviceId}`;
  return runDeviceSessionJob('route', key, async () => {
    if (input.messageId) {
      await captureFanoutSessionBeforeMutation({
        messageId: input.messageId,
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
      });
    }
    return encryptPlaintextForDeviceTargetUnlocked({
      ...input,
      senderDeviceId,
    });
  });
}

async function encryptPlaintextForDeviceTargetUnlocked(
  input: DeviceEncryptTargetInput,
): Promise<{ encryptedBody: string; senderDeviceId: string } | null> {
  if (!input.recipientDevicePublicKey) return null;
  if (isDeviceIdTemporary()) return null;
  if (isKnownInvalidDeviceId(input.recipientDeviceId)) return null;

  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();

  if (input.forceFreshSession) {
    await restartExpiredInitiatingSession({
      myUserId: input.senderUserId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
    }).catch(() => undefined);
  } else {
    const initiatingState = await prepareInitiatingSessionForSend({
      myUserId: input.senderUserId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
    });
    if (initiatingState === 'restart') {
      await restartExpiredInitiatingSession({
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
      });
    }
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
      encrypted = await wrapRatchetForInitiatingSession({
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
        ratchetPayload: encrypted,
      });
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
 * The current sender device is deliberately excluded because it already owns
 * the local plaintext. Other signed devices belonging to the sender remain
 * fan-out targets so cross-device history continues to work.
 *
 * Pass a synthetic `messageId` (e.g. the to-be-assigned UUID) — the same id
 * must then be reused when persisting the `messages` row.
 */
export async function buildFanoutCopies(input: FanoutInput): Promise<{ rows: FanoutCopyRow[]; hasTargets: boolean }> {
  if (isDeviceIdTemporary()) return { rows: [], hasTargets: false };
  const senderDeviceId = getCurrentDeviceId();

  const targets = (await resolveFanoutRoute(input.conversationId, input.senderUserId))
    .filter(device => !isKnownInvalidDeviceId(device.deviceId));
  if (targets.length === 0) return { rows: [], hasTargets: false };

  const rowResults = await mapWithConcurrency(targets, FANOUT_ENCRYPT_CONCURRENCY, async (dev) => {
    if (!dev.devicePublicKey || isKnownInvalidDeviceId(dev.deviceId)) return null;

    try {
      const encrypted = await encryptPlaintextForDeviceTarget({
        messageId: input.messageId,
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
  if (rows.length !== targets.length) {
    throw new Error('E2EE_DEVICE_COPY_BUILD_INCOMPLETE');
  }
  return { rows, hasTargets: true };
}

interface TryReadDeviceCopyOptions { requestRetry?: boolean; }

export async function tryReadDeviceCopy(
  messageId: string,
  expectedSenderUserId?: string,
  _options: TryReadDeviceCopyOptions = {},
): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  const userId = await getCachedAuthUserId();
  if (!userId || isDeviceIdTemporary()) return null;

  try {
    const { data } = await supabase.rpc('get_device_copy_for_message', {
      p_message_id: messageId,
      p_device_id: myDeviceId,
    });
    const rows = ((data ?? []) as CopyRow[])
      .map(row => ({ ...row, recipient_device_id: row.recipient_device_id ?? myDeviceId }))
      .filter(row => !expectedSenderUserId || row.sender_user_id === expectedSenderUserId);

    for (const row of rows) {
      const attempt = await tryDecryptCopy(row, userId, myDeviceId);
      if (attempt.plaintext !== null) return attempt.plaintext;
    }
    return null;
  } catch (error) {
    logCryptoException('decrypt', error, {
      severity: 'error',
      myDeviceId,
      metadata: { messageId, stage: 'sesame_lite_device_copy' },
    });
    return null;
  }
}

export async function tryDecryptDeviceTargetedBody(row: { encrypted_body: string; sender_user_id: string; sender_device_id: string }, userId: string, myDeviceId: string): Promise<string | null> {
  return (await tryDecryptCopy(row, userId, myDeviceId)).plaintext;
}

async function tryDecryptCopy(row: { encrypted_body: string; sender_user_id: string; sender_device_id: string }, userId: string, myDeviceId: string): Promise<DeviceCopyDecryptAttempt> {
  const key = `${userId}::${myDeviceId}::${row.sender_user_id}::${row.sender_device_id}`;
  return runDeviceSessionJob('route', key, () => tryDecryptCopyUnlocked(row, userId, myDeviceId));
}

async function tryDecryptCopyUnlocked(row: { encrypted_body: string; sender_user_id: string; sender_device_id: string }, userId: string, myDeviceId: string): Promise<DeviceCopyDecryptAttempt> {
  const prefix = classifyDeviceCopyPrefix(row.encrypted_body);
  try {
    if (prefix === 'x3dh5.init.v3') {
      const { data: senderPub } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
      if (!senderPub?.identity_key) {
        return { plaintext: null, attemptedSupportedEnvelope: true, retryable: false, reason: 'sender_identity_key_missing' };
      }
      const plaintext = await x3dhUnwrapForDevice(row.encrypted_body, userId, senderPub.identity_key, row.sender_user_id, row.sender_device_id);
      return {
        plaintext,
        attemptedSupportedEnvelope: true,
        retryable: plaintext === null,
        reason: plaintext === null ? 'x3dh5_init_decrypt_returned_null' : undefined,
      };
    }

    if (prefix === 'x3dh5') {
      const pt = await ratchetDecryptWithSession(userId, myDeviceId, row.sender_user_id, row.sender_device_id, row.encrypted_body);
      if (pt !== null) {
        await acknowledgeInitiatingSessionFromRatchetPayload({
          myUserId: userId,
          myDeviceId,
          peerUserId: row.sender_user_id,
          peerDeviceId: row.sender_device_id,
          ratchetPayload: row.encrypted_body,
        }).catch(() => undefined);
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
