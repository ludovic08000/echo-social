/**
 * Multi-device fan-out — distributes a sent message as additional, per-device
 * encrypted copies in `message_device_copies`.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';
import {
  isDevicePrekeyBundleError,
} from '@/lib/crypto/x3dh';
import { PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import {
  ratchetEncrypt,
  ratchetDecryptWithSession,
  AEGIS_RATCHET_PREFIX,
} from '@/lib/crypto/deviceRatchet';
import { parseAegisRatchetPayload } from '@/lib/crypto/aegisDeviceWire';
import { logCryptoException, logCryptoError } from '@/lib/crypto/errorLogger';
import { getCachedAuthUserId } from '@/lib/crypto/peerKeyCache';
import {
  invalidateFanoutRoute,
  resolveFanoutRouteSnapshot,
} from '@/lib/messaging/fanoutRouteCache';
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
import { traceE2EE } from '@/lib/messaging/e2eeTrace';
import { isAegisLibSignalCopy, openAegisCapsuleWithLibSignal, sealAegisCapsuleWithLibSignal } from '@/lib/messaging/aegisCryptoEngine';
import { claimLibSignalBundle } from '@/lib/messaging/libsignalBundleRegistry';

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

type DeviceCopyPrefix = 'aegis2.libsignal' | 'aegis1.init.v1' | 'aegis1.ratchet' | 'unsupported';

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

export type SyncedDeviceCopyRow = Required<Pick<CopyRow,
  'message_id' | 'encrypted_body' | 'sender_user_id' | 'sender_device_id' | 'recipient_device_id'
>>;

const deviceCopyCache = new Map<string, CopyRow | null>();
const deviceCopyMissAt = new Map<string, number>();
const deviceCopyPreloads = new Map<string, Promise<void>>();
const decryptedCapsuleCache = new Map<string, string>();
const DECRYPTED_CAPSULE_CACHE_CAP = 500;
const DEVICE_COPY_MISS_TTL_MS = 2_000;
const DEVICE_ROUTE_HEALTH_TTL_MS = 15_000;
let lastDeviceRouteHealthAt = 0;
let deviceRouteHealthInFlight: Promise<void> | null = null;

function copyCacheKey(userId: string, deviceId: string, messageId: string): string {
  return `${userId}|${deviceId}|${messageId}`;
}

export function clearDeviceCopyCache(): void {
  deviceCopyCache.clear();
  deviceCopyMissAt.clear();
  deviceCopyPreloads.clear();
  decryptedCapsuleCache.clear();
  lastDeviceRouteHealthAt = 0;
  deviceRouteHealthInFlight = null;
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
 * Injecte la capsule authentifiée rendue par l'inbox dans l'unique file locale.
 * Invariant Signal : on ne relit pas le réseau entre réception et déchiffrement.
 */
export function stageSyncedDeviceCopy(
  userId: string,
  deviceId: string,
  row: SyncedDeviceCopyRow,
): void {
  if (!userId || !deviceId || row.recipient_device_id !== deviceId) {
    throw new Error('AEGIS_SYNCED_COPY_SCOPE_MISMATCH');
  }
  const key = copyCacheKey(userId, deviceId, row.message_id);
  deviceCopyCache.set(key, row);
  deviceCopyMissAt.delete(key);
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
      const { data, error } = await supabase.rpc('get_device_copies_for_messages', {
        p_message_ids: batch,
        p_device_id: myDeviceId,
      });
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
  if (isAegisLibSignalCopy(body)) return 'aegis2.libsignal';
  if (isRepeatablePreKeyEnvelope(body)) return 'aegis1.init.v1';
  if (parseAegisRatchetPayload(body)) return 'aegis1.ratchet';
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
  conversationId?: string,
  options: { useOneTimePrekey?: boolean } = {},
): Promise<string | null> {
  try {
    return await createRepeatablePreKeyEnvelope({
      plaintext,
      senderUserId,
      senderDeviceId,
      recipientUserId,
      recipientDeviceId,
      conversationId,
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
  if (isDeviceIdTemporary()) return null;
  if (isKnownInvalidDeviceId(input.recipientDeviceId)) return null;

  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();
  const bundle = await claimLibSignalBundle(input.recipientUserId, input.recipientDeviceId);
  const encryptedBody = await sealAegisCapsuleWithLibSignal(input.plaintext, {
    recipientUserId: input.recipientUserId,
    recipientDeviceId: input.recipientDeviceId,
    bundle,
  });
  return { encryptedBody, senderDeviceId };
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
export async function buildFanoutCopies(input: FanoutInput, routeRefreshAttempt = 0): Promise<{
  rows: FanoutCopyRow[];
  hasTargets: boolean;
  routeVersion: string;
  omittedDeviceIds: string[];
}> {
  const startedAt = Date.now();
  const baseTrace = {
    direction: 'send' as const,
    component: 'device_fanout',
    messageId: input.messageId,
    conversationId: input.conversationId,
  };
  traceE2EE({ ...baseTrace, stage: 'ROUTE_SNAPSHOT', outcome: 'start' });
  if (isDeviceIdTemporary()) {
    traceE2EE({ ...baseTrace, stage: 'ROUTE_SNAPSHOT', outcome: 'error', errorCode: 'AEGIS_TEMPORARY_DEVICE_ID' }, 'warn');
    return { rows: [], hasTargets: false, routeVersion: '', omittedDeviceIds: [] };
  }
  const senderDeviceId = getCurrentDeviceId();

  const route = await resolveFanoutRouteSnapshot(input.conversationId, input.senderUserId);
  const targets = route.targets;
  traceE2EE({
    ...baseTrace,
    stage: 'ROUTE_SNAPSHOT',
    outcome: targets.length > 0 ? 'ok' : 'error',
    targetCount: targets.length,
    blockMs: Date.now() - startedAt,
    errorCode: targets.length === 0 ? 'E2EE_NO_SECURE_TARGET' : undefined,
  }, targets.length > 0 ? 'info' : 'warn');
  if (targets.length === 0) {
    // Registration/trust publication can finish between two outbox attempts;
    // never keep a negative route cached across the next bounded retry.
    invalidateFanoutRoute(input.conversationId, input.senderUserId);
    return { rows: [], hasTargets: false, routeVersion: route.version, omittedDeviceIds: [] };
  }

  const rowResults = await mapWithConcurrency(targets, FANOUT_ENCRYPT_CONCURRENCY, async (dev) => {
    const targetStartedAt = Date.now();
    traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_ENCRYPT', outcome: 'start', deviceId: senderDeviceId, peerDeviceId: dev.deviceId });
    if (!dev.devicePublicKey) {
      traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_ENCRYPT', outcome: 'error', peerDeviceId: dev.deviceId, errorCode: 'DEVICE_PUBLIC_KEY_MISSING' }, 'warn');
      return null;
    }

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
        traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_ENCRYPT', outcome: 'error', peerDeviceId: dev.deviceId, blockMs: Date.now() - targetStartedAt, errorCode: 'AEGIS_DEVICE_ROUTE_UNAVAILABLE' }, 'warn');
        return null;
      }
      traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_ENCRYPT', outcome: 'ok', peerDeviceId: dev.deviceId, blockMs: Date.now() - targetStartedAt });
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
      traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_ENCRYPT', outcome: 'error', peerDeviceId: dev.deviceId, blockMs: Date.now() - targetStartedAt, errorCode: e instanceof Error ? e.message : String(e) }, 'error');
      return null;
    }
  });

  const rows = rowResults.filter(Boolean) as FanoutCopyRow[];
  if (rows.length !== targets.length) {
    const omittedDeviceIds = targets
      .filter((dev) => !rows.some((row) => row.recipient_device_id === dev.deviceId))
      .map((dev) => dev.deviceId);

    await Promise.allSettled(targets.map((dev) => rollbackFanoutSessionTarget({
      messageId: input.messageId,
      myUserId: input.senderUserId,
      myDeviceId: senderDeviceId,
      peerUserId: dev.userId,
      peerDeviceId: dev.deviceId,
    })));
    if (routeRefreshAttempt === 0) {
      invalidateFanoutRoute(input.conversationId, input.senderUserId);
      traceE2EE({ ...baseTrace, stage: 'FANOUT_ROUTE_REFRESH', outcome: 'retry', targetCount: targets.length, copyCount: rows.length }, 'warn');
      return buildFanoutCopies(input, 1);
    }

    traceE2EE({ ...baseTrace, stage: 'FANOUT_EXACT_COVERAGE', outcome: 'error', targetCount: targets.length, copyCount: rows.length, errorCode: 'AEGIS_PARTIAL_DEVICE_FANOUT' }, 'error');
    logCryptoError({
      severity: 'warning',
      context: 'fanout',
      errorCode: 'AEGIS_PARTIAL_DEVICE_FANOUT',
      errorMessage: 'Every canonical Sesame device must have an encrypted copy',
      conversationId: input.conversationId,
      myDeviceId: senderDeviceId,
      metadata: { targetCount: targets.length, copyCount: rows.length, omittedCount: omittedDeviceIds.length, omittedDeviceIds },
    });
    requestOmittedRouteRepair(input.conversationId, input.senderUserId, omittedDeviceIds);
    throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE');
  }
  traceE2EE({ ...baseTrace, stage: 'FANOUT_EXACT_COVERAGE', outcome: 'ok', targetCount: targets.length, copyCount: rows.length, blockMs: Date.now() - startedAt });
  return { rows, hasTargets: true, routeVersion: route.version, omittedDeviceIds: [] };
}

/**
 * Nudge local de réparation: la route omise est invalidée et un événement
 * applicatif est émis. Aucun secret n'est exposé, seulement des DeviceID.
 */
function requestOmittedRouteRepair(
  conversationId: string,
  senderUserId: string,
  omittedDeviceIds: string[],
): void {
  if (omittedDeviceIds.length === 0) return;
  invalidateFanoutRoute(conversationId, senderUserId);
  try {
    window.dispatchEvent(new CustomEvent('forsure:aegis-route-repair-needed', {
      detail: { reason: 'partial-device-fanout', omittedDeviceIds },
    }));
  } catch {
    // Best-effort outside the DOM runtime.
  }
}


interface TryReadDeviceCopyOptions { requestRetry?: boolean; }

function requestCurrentDeviceRouteRepair(userId: string, deviceId: string): void {
  if (Date.now() - lastDeviceRouteHealthAt < DEVICE_ROUTE_HEALTH_TTL_MS) return;
  if (deviceRouteHealthInFlight) return;
  lastDeviceRouteHealthAt = Date.now();

  deviceRouteHealthInFlight = import('@/lib/crypto/canonicalDeviceRegistry')
    .then(({ fetchVerifiedDeviceList }) => fetchVerifiedDeviceList(userId))
    .then((verified) => {
      if (verified.trusted.some((entry) => entry.deviceId === deviceId && entry.isRoutable)) return;
      try {
        window.dispatchEvent(new CustomEvent('forsure:device-self-repair-required', {
          detail: {
            reason: 'current-device-route-missing',
            deviceId,
          },
        }));
      } catch {
        // Browser event delivery is best-effort outside the DOM runtime.
      }
    })
    .catch(() => undefined)
    .finally(() => {
      deviceRouteHealthInFlight = null;
    });
}

async function loadDeviceCopyRows(
  messageId: string,
  _userId: string,
  deviceId: string,
): Promise<CopyRow[]> {
  const rpcResult = await supabase.rpc('get_device_copies_for_messages', {
    p_message_ids: [messageId],
    p_device_id: deviceId,
  });
  if (rpcResult.error) {
    throw new Error(
      `AEGIS_DEVICE_COPY_LOOKUP_FAILED:${rpcResult.error.code ?? 'RPC'}:${rpcResult.error.message}`,
    );
  }
  return ((rpcResult.data ?? []) as CopyRow[])
    .map((row) => ({ ...row, recipient_device_id: row.recipient_device_id ?? deviceId }));
}

export async function tryReadDeviceCopy(
  messageId: string,
  expectedSenderUserId?: string,
  options: TryReadDeviceCopyOptions = {},
): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  const userId = await getCachedAuthUserId();
  const baseTrace = { direction: 'receive' as const, component: 'device_copy_reader', messageId, deviceId: myDeviceId };
  traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_LOOKUP', outcome: 'start' });
  if (!userId || isDeviceIdTemporary()) {
    traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_LOOKUP', outcome: 'error', errorCode: !userId ? 'AUTH_USER_MISSING' : 'AEGIS_TEMPORARY_DEVICE_ID' }, 'warn');
    return null;
  }

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
      if (alreadyDecrypted !== undefined) {
        traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_DECRYPT', outcome: 'ok', cache: 'memory', peerDeviceId: cached.sender_device_id });
        return alreadyDecrypted;
      }
      const plaintext = (await tryDecryptCopy(cached, userId, myDeviceId)).plaintext;
      if (plaintext !== null) rememberDecryptedCapsule(capsuleKey, plaintext);
      traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_DECRYPT', outcome: plaintext !== null ? 'ok' : 'error', cache: 'memory', peerDeviceId: cached.sender_device_id, errorCode: plaintext === null ? 'DEVICE_COPY_DECRYPT_NULL' : undefined }, plaintext !== null ? 'info' : 'warn');
      return plaintext;
    }
    if (hasCachedResult && cached === null) {
      const missAt = deviceCopyMissAt.get(cacheKey) ?? 0;
      const missIsFresh = Date.now() - missAt < DEVICE_COPY_MISS_TTL_MS;
      if (!options.requestRetry && missIsFresh) return null;
      deviceCopyCache.delete(cacheKey);
      deviceCopyMissAt.delete(cacheKey);
    }

    const rows = (await loadDeviceCopyRows(messageId, userId, myDeviceId))
      .filter(row => !expectedSenderUserId || row.sender_user_id === expectedSenderUserId);
    traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_LOOKUP', outcome: rows.length > 0 ? 'ok' : 'retry', cache: 'network', copyCount: rows.length, transport: 'supabase' }, rows.length > 0 ? 'info' : 'warn');

    if (rows.length === 0 && options.requestRetry) {
      // A historical message can legitimately predate this DeviceID. Repair
      // registration only when the canonical signed route also says the
      // current device is missing; a lone old copy miss must not rotate keys.
      requestCurrentDeviceRouteRepair(userId, myDeviceId);
      if (expectedSenderUserId) {
        const { data, error } = await supabase.rpc('request_device_copy_retry', {
          p_message_id: messageId,
          p_sender_user_id: expectedSenderUserId,
          p_requester_device_id: myDeviceId,
        });
        const result = data as { ok?: boolean; code?: string } | null;
        traceE2EE({
          direction: 'receive',
          stage: error || result?.ok !== true
            ? 'DEVICE_COPY_RETRY_REQUEST_FAILED'
            : 'DEVICE_COPY_RETRY_REQUESTED',
          messageId,
          deviceId: myDeviceId,
          errorCode: error?.message ?? result?.code,
        }, error || result?.ok !== true ? 'warn' : 'info');
      }
    }

    for (const row of rows) {
      deviceCopyCache.set(cacheKey, row);
      deviceCopyMissAt.delete(cacheKey);
      const capsuleKey = decryptedCapsuleKey(userId, myDeviceId, messageId, row.encrypted_body);
      const alreadyDecrypted = decryptedCapsuleCache.get(capsuleKey);
      if (alreadyDecrypted !== undefined) return alreadyDecrypted;
      const attempt = await tryDecryptCopy(row, userId, myDeviceId);
      traceE2EE({
        ...baseTrace,
        stage: 'DEVICE_COPY_DECRYPT',
        outcome: attempt.plaintext !== null ? 'ok' : 'error',
        cache: 'network',
        peerDeviceId: row.sender_device_id,
        errorCode: attempt.reason,
      }, attempt.plaintext !== null ? 'info' : 'warn');
      if (attempt.plaintext !== null) {
        rememberDecryptedCapsule(capsuleKey, attempt.plaintext);
        return attempt.plaintext;
      }
    }
    if (rows.length > 0 && options.requestRetry && expectedSenderUserId) {
      const { data, error } = await supabase.rpc('request_device_copy_retry', {
        p_message_id: messageId,
        p_sender_user_id: expectedSenderUserId,
        p_requester_device_id: myDeviceId,
      });
      const result = data as { ok?: boolean; code?: string } | null;
      traceE2EE({
        direction: 'receive',
        stage: error || result?.ok !== true
          ? 'DEVICE_COPY_RETRY_REQUEST_FAILED'
          : 'UNDECRYPTABLE_COPY_RETRY_REQUESTED',
        messageId,
        deviceId: myDeviceId,
        errorCode: error?.message ?? result?.code,
      }, error || result?.ok !== true ? 'warn' : 'info');
    }
    deviceCopyCache.set(cacheKey, null);
    deviceCopyMissAt.set(cacheKey, Date.now());
    traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_UNAVAILABLE', outcome: 'retry', cache: 'miss' }, 'warn');
    return null;
  } catch (error) {
    logCryptoException('decrypt', error, {
      severity: 'error',
      myDeviceId,
      metadata: { messageId, stage: 'aegis_device_key_capsule' },
    });
    traceE2EE({ ...baseTrace, stage: 'DEVICE_COPY_LOOKUP', outcome: 'error', errorCode: error instanceof Error ? error.message : String(error) }, 'error');
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
    if (prefix === 'aegis2.libsignal') {
      const plaintext = await openAegisCapsuleWithLibSignal({ senderUserId: row.sender_user_id, senderDeviceId: row.sender_device_id, encryptedBody: row.encrypted_body });
      return { plaintext, attemptedSupportedEnvelope: true, retryable: false };
    }
    if (prefix === 'aegis1.init.v1') {
      const { fetchVerifiedDeviceIdentity } = await import('@/lib/crypto/canonicalDeviceRegistry');
      const senderDevice = await fetchVerifiedDeviceIdentity(
        row.sender_user_id,
        row.sender_device_id,
      );
      if (!senderDevice) {
        return { plaintext: null, attemptedSupportedEnvelope: true, retryable: false, reason: 'sender_device_not_authorized' };
      }
      const plaintext = await x3dhUnwrapForDevice(row.encrypted_body, userId, senderDevice.devicePublicKey, row.sender_user_id, row.sender_device_id);
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
