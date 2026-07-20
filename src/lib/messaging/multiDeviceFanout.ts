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
  AEGIS_RATCHET_PREFIX,
} from '@/lib/crypto/deviceRatchet';
import { logCryptoException, logCryptoError } from '@/lib/crypto/errorLogger';
import { getCachedAuthUserId } from '@/lib/crypto/peerKeyCache';
import { invalidateFanoutRoute, resolveFanoutRoute } from '@/lib/messaging/fanoutRouteCache';
import {
  captureFanoutSessionBeforeMutation,
  rollbackFanoutSessionTarget,
} from '@/lib/messaging/fanoutSessionTransaction';
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
  useOneTimePrekey?: boolean;
}

const FANOUT_ENCRYPT_CONCURRENCY = 2;
const INVALID_DEVICE_QUARANTINE_MS = 60_000;

type DeviceCopyPrefix = 'aegis1.init.v1' | 'aegis1.ratchet' | 'unsupported';

interface DeviceCopyDecryptAttempt {
  plaintext: string | null;
  attemptedSupportedEnvelope: boolean;
  retryable: boolean;
  reason?: string;
}

type CopyRow = {
  message_id?: string;
  encrypted_body: string;
  sender_user_id: string;
  sender_device_id: string;
  recipient_device_id?: string;
};

const deviceCopyCache = new Map<string, CopyRow | null>();
const deviceCopyMissAt = new Map<string, number>();
const deviceCopyPreloads = new Map<string, Promise<void>>();
const decryptedCapsuleCache = new Map<string, string>();
const DECRYPTED_CAPSULE_CACHE_CAP = 500;
const DEVICE_COPY_MISS_TTL_MS = 2_000;

function copyCacheKey(userId: string, deviceId: string, messageId: string): string {
  return `${userId}|${deviceId}|${messageId}`;
}

export function clearDeviceCopyCache(): void {
  deviceCopyCache.clear();
  deviceCopyMissAt.clear();
  deviceCopyPreloads.clear();
  decryptedCapsuleCache.clear();
}

export function clearDeviceCopyCacheForMessage(messageId: string): void {
  if (!messageId) return;
  const suffix = `|${messageId}`;
  for (const key of deviceCopyCache.keys()) {
    if (key.endsWith(suffix)) {
      deviceCopyCache.delete(key);
      deviceCopyMissAt.delete(key);
    }
  }
}

/**
 * Loads the visible device-copy window in one query. The server RLS still
 * restricts rows to the authenticated recipient; this cache only removes the
 * previous one-RPC-per-bubble startup pattern.
 */
export async function preloadDeviceCopies(messageIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(messageIds.filter(Boolean))];
  if (uniqueIds.length === 0) return;
  const myDeviceId = getCurrentDeviceId();
  const userId = await getCachedAuthUserId();
  if (!userId || isDeviceIdTemporary()) return;

  const missing = uniqueIds.filter((messageId) =>
    !deviceCopyCache.has(copyCacheKey(userId, myDeviceId, messageId)),
  );
  if (missing.length === 0) return;

  const preloadKey = `${userId}|${myDeviceId}|${missing.slice().sort().join(',')}`;
  const existing = deviceCopyPreloads.get(preloadKey);
  if (existing) return existing;

  const task = (async () => {
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const { data, error } = await supabase
        .from('message_device_copies')
        .select('message_id,encrypted_body,sender_user_id,sender_device_id,recipient_device_id')
        .in('message_id', batch)
        .eq('recipient_user_id', userId)
        .eq('recipient_device_id', myDeviceId);
      if (error) throw error;
      for (const messageId of batch) {
        const cacheKey = copyCacheKey(userId, myDeviceId, messageId);
        deviceCopyCache.set(cacheKey, null);
        deviceCopyMissAt.set(cacheKey, Date.now());
      }
      for (const row of (data ?? []) as CopyRow[]) {
        if (!row.message_id) continue;
        const cacheKey = copyCacheKey(userId, myDeviceId, row.message_id);
        deviceCopyCache.set(cacheKey, row);
        deviceCopyMissAt.delete(cacheKey);
      }
    }
  })().finally(() => {
    deviceCopyPreloads.delete(preloadKey);
  });
  deviceCopyPreloads.set(preloadKey, task);
  return task;
}

function classifyDeviceCopyPrefix(body: string): DeviceCopyPrefix {
  if (isRepeatablePreKeyEnvelope(body)) return 'aegis1.init.v1';
  if (body.startsWith(AEGIS_RATCHET_PREFIX)) return 'aegis1.ratchet';
  return 'unsupported';
}

function decryptedCapsuleKey(
  userId: string,
  deviceId: string,
  messageId: string,
  encryptedBody: string,
): string {
  return `${userId}|${deviceId}|${messageId}|${encryptedBody}`;
}

function rememberDecryptedCapsule(key: string, plaintext: string): void {
  decryptedCapsuleCache.delete(key);
  decryptedCapsuleCache.set(key, plaintext);
  while (decryptedCapsuleCache.size > DECRYPTED_CAPSULE_CACHE_CAP) {
    const oldest = decryptedCapsuleCache.keys().next().value as string | undefined;
    if (!oldest) break;
    decryptedCapsuleCache.delete(oldest);
  }
}

const invalidDeviceUntil = new Map<string, number>();

function markInvalidDeviceId(deviceId: string | null | undefined): void {
  if (!deviceId) return;
  invalidDeviceUntil.set(deviceId, Date.now() + INVALID_DEVICE_QUARANTINE_MS);
}

function isKnownInvalidDeviceId(deviceId: string | null | undefined): boolean {
  if (!deviceId) return false;
  const until = invalidDeviceUntil.get(deviceId) ?? 0;
  if (until > Date.now()) return true;
  if (until > 0) invalidDeviceUntil.delete(deviceId);
  return false;
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
        metadata: { stage: 'aegis_device_init_v1', action: 'device_quarantined' },
      });
    } else {
      logCryptoException('fanout', error, {
        severity: 'warning',
        peerUserId: recipientUserId,
        peerDeviceId: recipientDeviceId,
        metadata: { stage: 'aegis_device_init_v1' },
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
    if (encrypted && encrypted.startsWith(AEGIS_RATCHET_PREFIX)) {
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

  // Aegis fast path: an existing Double Ratchet session is used without a
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
          errorMessage: 'Skipping SPK freshness check because the peer Aegis bundle is unavailable',
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
      errorCode: 'AEGIS_DEVICE_ROUTE_UNAVAILABLE',
      errorMessage: 'No Aegis ratchet/bootstrap path for recipient device',
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
 * Encrypts the key capsule for every recipient device without writing a
 * partial message. The rows can only be committed with their parent by the
 * atomic `aegis_send_message` RPC.
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
  if (targets.length === 0) {
    // Registration/trust publication can finish between two outbox attempts;
    // never keep a negative route cached across the next bounded retry.
    invalidateFanoutRoute(input.conversationId, input.senderUserId);
    return { rows: [], hasTargets: false };
  }

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
      if (!encrypted) {
        await rollbackFanoutSessionTarget({
          messageId: input.messageId,
          myUserId: input.senderUserId,
          myDeviceId: senderDeviceId,
          peerUserId: dev.userId,
          peerDeviceId: dev.deviceId,
        }).catch(() => false);
        return null;
      }
      return {
        message_id: input.messageId,
        recipient_user_id: dev.userId,
        recipient_device_id: dev.deviceId,
        sender_user_id: input.senderUserId,
        sender_device_id: encrypted.senderDeviceId,
        encrypted_body: encrypted.encryptedBody,
      } as FanoutCopyRow;
    } catch (e) {
      await rollbackFanoutSessionTarget({
        messageId: input.messageId,
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: dev.userId,
        peerDeviceId: dev.deviceId,
      }).catch(() => false);
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
    logCryptoError({
      severity: 'warning',
      context: 'fanout',
      errorCode: 'AEGIS_PARTIAL_DEVICE_FANOUT',
      errorMessage: 'Some authenticated device routes were unavailable',
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      metadata: {
        targetCount: targets.length,
        copyCount: rows.length,
        omittedCount: targets.length - rows.length,
      },
    });
    // Never hand a partial route to the server. The parent message must remain
    // in the durable outbox until every canonical device has its capsule.
    throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE');
  }
  return { rows, hasTargets: true };
}

interface TryReadDeviceCopyOptions { requestRetry?: boolean; }

export async function tryReadDeviceCopy(
  messageId: string,
  expectedSenderUserId?: string,
  options: TryReadDeviceCopyOptions = {},
): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  const userId = await getCachedAuthUserId();
  if (!userId || isDeviceIdTemporary()) return null;

  try {
    const cacheKey = copyCacheKey(userId, myDeviceId, messageId);
    const hasCachedResult = deviceCopyCache.has(cacheKey);
    const cached = deviceCopyCache.get(cacheKey);
    if (cached && (!expectedSenderUserId || cached.sender_user_id === expectedSenderUserId)) {
      const capsuleKey = decryptedCapsuleKey(
        userId,
        myDeviceId,
        messageId,
        cached.encrypted_body,
      );
      const alreadyDecrypted = decryptedCapsuleCache.get(capsuleKey);
      if (alreadyDecrypted !== undefined) return alreadyDecrypted;
      const plaintext = (await tryDecryptCopy(cached, userId, myDeviceId)).plaintext;
      if (plaintext !== null) rememberDecryptedCapsule(capsuleKey, plaintext);
      return plaintext;
    }
    if (hasCachedResult && cached === null) {
      const missAt = deviceCopyMissAt.get(cacheKey) ?? 0;
      const missIsFresh = Date.now() - missAt < DEVICE_COPY_MISS_TTL_MS;
      if (!options.requestRetry && missIsFresh) return null;
      deviceCopyCache.delete(cacheKey);
      deviceCopyMissAt.delete(cacheKey);
    }

    const { data } = await supabase.rpc('get_device_copy_for_message', {
      p_message_id: messageId,
      p_device_id: myDeviceId,
    });
    const rows = ((data ?? []) as CopyRow[])
      .map(row => ({ ...row, recipient_device_id: row.recipient_device_id ?? myDeviceId }))
      .filter(row => !expectedSenderUserId || row.sender_user_id === expectedSenderUserId);

    for (const row of rows) {
      deviceCopyCache.set(cacheKey, row);
      deviceCopyMissAt.delete(cacheKey);
      const capsuleKey = decryptedCapsuleKey(userId, myDeviceId, messageId, row.encrypted_body);
      const alreadyDecrypted = decryptedCapsuleCache.get(capsuleKey);
      if (alreadyDecrypted !== undefined) return alreadyDecrypted;
      const attempt = await tryDecryptCopy(row, userId, myDeviceId);
      if (attempt.plaintext !== null) {
        rememberDecryptedCapsule(capsuleKey, attempt.plaintext);
        return attempt.plaintext;
      }
    }
    deviceCopyCache.set(cacheKey, null);
    deviceCopyMissAt.set(cacheKey, Date.now());
    return null;
  } catch (error) {
    logCryptoException('decrypt', error, {
      severity: 'error',
      myDeviceId,
      metadata: { messageId, stage: 'aegis_device_key_capsule' },
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
    if (prefix === 'aegis1.init.v1') {
      const { data: senderPub } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
      if (!senderPub?.identity_key) {
        return { plaintext: null, attemptedSupportedEnvelope: true, retryable: false, reason: 'sender_identity_key_missing' };
      }
      const plaintext = await x3dhUnwrapForDevice(row.encrypted_body, userId, senderPub.identity_key, row.sender_user_id, row.sender_device_id);
      return {
        plaintext,
        attemptedSupportedEnvelope: true,
        retryable: plaintext === null,
        reason: plaintext === null ? 'aegis_init_decrypt_returned_null' : undefined,
      };
    }

    if (prefix === 'aegis1.ratchet') {
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
