/**
 * Sender Keys outbound pipeline (encrypt-side wiring).
 *
 * Responsibilities — pure orchestration, no new crypto:
 *   1. Decide whether the conversation has opted in (`conversations.enable_sender_keys`).
 *   2. Ensure an owner chain exists (creating it on first send) and apply
 *      the auto-rotation policy (count/age) from `senderKeySession`.
 *   3. Encrypt the plaintext into a `sk1.` wire string via `encryptForGroup`.
 *   4. Whenever a fresh chain (or rotated chain) needs to be advertised,
 *      build an SKDM and fan it out to every peer device via the existing
 *      pairwise ratchet, persisting one row per (recipient_device) into
 *      `sender_key_distribution`.
 *
 * Inbound consumption of `sender_key_distribution` (recipient pulls the
 * encrypted SKDM, decrypts pairwise, then calls `installSKDM`) is the
 * NEXT batch — kept out of this file on purpose.
 *
 * SAFETY:
 *   - All failures degrade silently to `null`; the caller falls back to the
 *     pairwise ratchet path so messages are never lost.
 *   - The flag check is cached and can be prewarmed when the chat opens, so a
 *     database read is never part of the common click-to-encrypt path.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { listDevicesForUser } from '@/e2ee-session/deviceRegistry';
import {
  ensureOwnerSession,
  encryptForGroup,
  maybeAutoRotate,
  snapshotForDistribution,
  type OwnerState,
} from './senderKeySession';
import { encryptPlaintextForDeviceTarget } from '@/lib/messaging/multiDeviceFanout';

interface ActiveDevice {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
}

const FLAG_ENABLED_TTL_MS = 30_000;
const FLAG_DISABLED_TTL_MS = 10 * 60_000;
const flagCache = new Map<string, { enabled: boolean; ts: number }>();
const flagPromises = new Map<string, Promise<boolean>>();

/** Versions of (conversationId, deviceId) for which we already fanned out the
 *  current chain snapshot. Lets us skip the SKDM fanout on every send while
 *  still re-fanning after a rotation (iteration resets to 0). */
const lastDistributedSnapshot = new Map<string, string>();

function snapshotKey(conversationId: string, senderDeviceId: string): string {
  return `${conversationId}::${senderDeviceId}`;
}

function snapshotFingerprint(s: OwnerState): string {
  // signingPub uniquely identifies a chain GENERATION (regenerated only on
  // rotation). chainKeyB64 advances at every send, so we deliberately exclude
  // it — otherwise we'd re-fan-out the SKDM on every keystroke.
  return s.signingPubB64;
}

async function fetchSenderKeysFlag(conversationId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('conversations')
      .select('enable_sender_keys')
      .eq('id', conversationId)
      .maybeSingle();
    const enabled = !!(data as any)?.enable_sender_keys;
    flagCache.set(conversationId, { enabled, ts: Date.now() });
    return enabled;
  } catch {
    flagCache.set(conversationId, { enabled: false, ts: Date.now() });
    return false;
  }
}

async function isSenderKeysEnabled(conversationId: string): Promise<boolean> {
  const cached = flagCache.get(conversationId);
  const now = Date.now();
  if (cached) {
    const ttl = cached.enabled ? FLAG_ENABLED_TTL_MS : FLAG_DISABLED_TTL_MS;
    if (now - cached.ts < ttl) return cached.enabled;
  }

  const existing = flagPromises.get(conversationId);
  if (existing) return existing;

  const promise = fetchSenderKeysFlag(conversationId)
    .finally(() => {
      if (flagPromises.get(conversationId) === promise) flagPromises.delete(conversationId);
    });
  flagPromises.set(conversationId, promise);
  return promise;
}

/** Warm the opt-in flag while the conversation is opening. */
export async function prewarmSenderKeysFlag(conversationId: string): Promise<void> {
  if (!conversationId) return;
  await isSenderKeysEnabled(conversationId);
}

/** Manually invalidate the cached flag (used when the UI toggles it). */
export function invalidateSenderKeysFlag(conversationId: string): void {
  flagCache.delete(conversationId);
  flagPromises.delete(conversationId);
  // Force re-fanout of SKDM after a manual rotation/toggle.
  for (const k of Array.from(lastDistributedSnapshot.keys())) {
    if (k.startsWith(`${conversationId}::`)) lastDistributedSnapshot.delete(k);
  }
}

async function listPeerDevices(
  conversationId: string,
  selfUserId: string,
  selfDeviceId: string,
): Promise<ActiveDevice[]> {
  const { data: participants } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId);
  if (!participants?.length) return [];
  const userIds = participants.map((p: any) => p.user_id);

  const lists = await Promise.all(
    userIds.map(async (uid) => {
      try {
        return (await listDevicesForUser(uid)).map((d) => ({
          userId: d.userId,
          deviceId: d.deviceId,
          devicePublicKey: d.devicePublicKey,
        })) as ActiveDevice[];
      } catch {
        return [] as ActiveDevice[];
      }
    }),
  );
  return lists
    .flat()
    .filter((d) => d.devicePublicKey)
    .filter((d) => !(d.userId === selfUserId && d.deviceId === selfDeviceId));
}

async function fanoutSKDM(
  conversationId: string,
  selfUserId: string,
  selfDeviceId: string,
  skdmPlaintext: string,
): Promise<void> {
  const peers = await listPeerDevices(conversationId, selfUserId, selfDeviceId);
  if (!peers.length) return;

  const rows: Array<Record<string, string>> = [];
  for (const dev of peers) {
    try {
      const wrapped = await encryptPlaintextForDeviceTarget({
        conversationId,
        senderUserId: selfUserId,
        senderDeviceId: selfDeviceId,
        recipientUserId: dev.userId,
        recipientDeviceId: dev.deviceId,
        recipientDevicePublicKey: dev.devicePublicKey,
        plaintext: skdmPlaintext,
      });
      if (!wrapped) continue;
      rows.push({
        conversation_id: conversationId,
        sender_user_id: selfUserId,
        sender_device_id: selfDeviceId,
        recipient_user_id: dev.userId,
        recipient_device_id: dev.deviceId,
        encrypted_skdm: wrapped.encryptedBody,
      });
    } catch (e) {
      console.warn('[SK_FANOUT] device wrap failed', { peer: dev.deviceId, e });
    }
  }
  if (!rows.length) return;
  const { error } = await supabase
    .from('sender_key_distribution')
    .insert(rows as any);
  if (error) {
    console.warn('[SK_FANOUT] insert failed — recipients will rebootstrap on next chain', error);
  }
}

/**
 * Try the Sender Keys path for an outbound message. Returns the `sk1.` wire
 * on success, or `null` if the conversation isn't opted in / device id is
 * not yet stable / orchestration failed (caller falls back to pairwise).
 */
export async function tryEncryptViaSenderKeys(
  conversationId: string,
  senderUserId: string,
  plaintext: string,
): Promise<string | null> {
  if (!conversationId || !senderUserId) return null;
  if (isDeviceIdTemporary()) return null;

  const enabled = await isSenderKeysEnabled(conversationId);
  if (!enabled) return null;

  try {
    const senderDeviceId = getCurrentDeviceId();

    // 1. Ensure / load owner state.
    let owner = await ensureOwnerSession(conversationId, senderUserId, senderDeviceId);

    // 2. Apply auto-rotation policy (1k msgs / 7d).
    const rotated = await maybeAutoRotate(owner);
    if (rotated) owner = rotated.state;

    // 3. Fan out SKDM if this chain generation hasn't been advertised yet.
    const fpKey = snapshotKey(conversationId, senderDeviceId);
    const fp = snapshotFingerprint(owner);
    if (lastDistributedSnapshot.get(fpKey) !== fp) {
      try {
        const skdm = snapshotForDistribution(owner);
        await fanoutSKDM(conversationId, senderUserId, senderDeviceId, skdm);
        lastDistributedSnapshot.set(fpKey, fp);
      } catch (e) {
        // Fan-out failure is non-fatal: recipients can still rebootstrap on
        // next chain, and we'll retry on the next send.
        console.warn('[SK_OUTBOUND] SKDM fanout failed (will retry next send)', e);
      }
    }

    // 4. Encrypt + advance chain.
    const { wire } = await encryptForGroup(owner, plaintext);
    return wire;
  } catch (e) {
    console.warn('[SK_OUTBOUND] sender-key encrypt failed; falling back to pairwise', e);
    return null;
  }
}
