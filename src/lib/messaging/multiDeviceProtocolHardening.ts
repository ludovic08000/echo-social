import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';

/**
 * Multi-device protocol hardening layer.
 *
 * Additive helpers for:
 * - read receipts per device;
 * - typing indicators per device;
 * - Lamport ordering for deterministic message merge;
 * - anti-replay cache per account/device;
 * - multi-account device isolation.
 *
 * This file does not change the identity key. Identity remains account-stable.
 */

const REPLAY_DB_NAME = 'forsure-anti-replay';
const REPLAY_DB_VERSION = 1;
const REPLAY_STORE = 'seen';
const ACCOUNT_DEVICE_KEY = 'forsure-active-account-device-v1';
const LAMPORT_KEY_PREFIX = 'forsure-lamport-clock:';
const MAX_REPLAY_ROWS_PER_DEVICE = 20_000;

export interface ReadReceiptInput {
  userId: string;
  conversationId: string;
  messageId: string;
  readAt?: string;
}

export interface TypingIndicatorInput {
  userId: string;
  conversationId: string;
  isTyping: boolean;
}

export interface LamportMessageLike {
  id: string;
  sender_id: string;
  created_at: string;
  lamport_ts?: number | null;
  device_id?: string | null;
}

export interface AntiReplayInput {
  accountId: string;
  deviceId?: string;
  messageId: string;
  senderUserId: string;
  senderDeviceId?: string | null;
  envelopeHash: string;
}

interface ReplayRow extends AntiReplayInput {
  id: string;
  seenAt: number;
}

function nowIso() {
  return new Date().toISOString();
}

function lamportKey(userId: string, conversationId: string) {
  return `${LAMPORT_KEY_PREFIX}${userId}:${conversationId}`;
}

export function nextLamportTimestamp(userId: string, conversationId: string, observedRemote?: number | null): number {
  const key = lamportKey(userId, conversationId);
  let current = 0;
  try {
    current = Number(localStorage.getItem(key) || '0') || 0;
  } catch {
    current = 0;
  }
  const next = Math.max(current, observedRemote || 0) + 1;
  try {
    localStorage.setItem(key, String(next));
  } catch {
    // non-fatal
  }
  return next;
}

export function observeLamportTimestamp(userId: string, conversationId: string, remoteTs?: number | null): number {
  if (!remoteTs || remoteTs <= 0) return nextLamportTimestamp(userId, conversationId, null) - 1;
  const key = lamportKey(userId, conversationId);
  let current = 0;
  try {
    current = Number(localStorage.getItem(key) || '0') || 0;
    localStorage.setItem(key, String(Math.max(current, remoteTs)));
  } catch {
    // non-fatal
  }
  return Math.max(current, remoteTs);
}

/** Deterministic ordering: Lamport first, then server time, then id. */
export function sortMessagesDeterministically<T extends LamportMessageLike>(messages: T[]): T[] {
  return [...messages].sort((a, b) => {
    const la = a.lamport_ts ?? 0;
    const lb = b.lamport_ts ?? 0;
    if (la !== lb) return la - lb;
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (ta !== tb) return ta - tb;
    const da = a.device_id ?? '';
    const db = b.device_id ?? '';
    if (da !== db) return da.localeCompare(db);
    return a.id.localeCompare(b.id);
  });
}

/**
 * Publish a per-device read receipt.
 * Requires table `message_read_receipts` with unique(message_id, user_id, device_id).
 */
export async function publishReadReceipt(input: ReadReceiptInput): Promise<boolean> {
  const deviceId = getCurrentDeviceId();
  try {
    const { error } = await supabase
      .from('message_read_receipts' as any)
      .upsert({
        message_id: input.messageId,
        conversation_id: input.conversationId,
        user_id: input.userId,
        device_id: deviceId,
        read_at: input.readAt ?? nowIso(),
      }, { onConflict: 'message_id,user_id,device_id' });

    if (error) throw error;
    return true;
  } catch (error) {
    logCryptoException('sync', error, {
      severity: 'warning',
      conversationId: input.conversationId,
      myDeviceId: deviceId,
      metadata: { stage: 'publish_read_receipt', messageId: input.messageId },
    });
    return false;
  }
}

/**
 * Subscribe to read receipts in a conversation.
 */
export function subscribeReadReceipts(
  conversationId: string,
  onReceipt: (receipt: any) => void,
): () => void {
  const channel = supabase
    .channel(`read-receipts:${conversationId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'message_read_receipts',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => onReceipt(payload.new ?? payload.old),
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}

/**
 * Realtime typing indicator using Supabase broadcast. No DB writes needed.
 */
export function createTypingIndicatorSync(
  conversationId: string,
  onTyping: (event: { userId: string; deviceId: string; isTyping: boolean; at: string }) => void,
) {
  const channel = supabase.channel(`typing:${conversationId}`, {
    config: { broadcast: { self: false } },
  });

  channel.on('broadcast', { event: 'typing' }, ({ payload }) => {
    if (!payload?.userId || !payload?.deviceId) return;
    onTyping(payload);
  });

  channel.subscribe();

  let lastSent = 0;
  const sendTyping = async (input: TypingIndicatorInput) => {
    const now = Date.now();
    if (input.isTyping && now - lastSent < 1200) return;
    lastSent = now;
    await channel.send({
      type: 'broadcast',
      event: 'typing',
      payload: {
        userId: input.userId,
        deviceId: getCurrentDeviceId(),
        conversationId: input.conversationId,
        isTyping: input.isTyping,
        at: nowIso(),
      },
    });
  };

  const stop = () => supabase.removeChannel(channel);
  return { sendTyping, stop };
}

function openReplayDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(REPLAY_DB_NAME, REPLAY_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(REPLAY_STORE)) {
        const store = db.createObjectStore(REPLAY_STORE, { keyPath: 'id' });
        store.createIndex('accountDevice', ['accountId', 'deviceId'], { unique: false });
        store.createIndex('seenAt', 'seenAt', { unique: false });
      }
    };
  });
}

function replayId(input: AntiReplayInput): string {
  const deviceId = input.deviceId ?? getCurrentDeviceId();
  return [
    input.accountId,
    deviceId,
    input.senderUserId,
    input.senderDeviceId ?? 'unknown',
    input.messageId,
    input.envelopeHash,
  ].join('::');
}

/**
 * Returns false if this exact encrypted envelope was already processed.
 */
export async function markEnvelopeSeenOnce(input: AntiReplayInput): Promise<boolean> {
  const deviceId = input.deviceId ?? getCurrentDeviceId();
  const row: ReplayRow = {
    ...input,
    deviceId,
    id: replayId({ ...input, deviceId }),
    seenAt: Date.now(),
  };

  try {
    const db = await openReplayDB();
    const existing = await new Promise<ReplayRow | undefined>((resolve, reject) => {
      const tx = db.transaction(REPLAY_STORE, 'readonly');
      const req = tx.objectStore(REPLAY_STORE).get(row.id);
      req.onsuccess = () => resolve(req.result as ReplayRow | undefined);
      req.onerror = () => reject(req.error);
    });
    if (existing) {
      logCryptoError({
        severity: 'warning',
        context: 'anti-replay',
        errorCode: 'REPLAY_BLOCKED',
        errorMessage: 'Duplicate encrypted envelope rejected',
        myDeviceId: deviceId,
        metadata: { messageId: input.messageId, senderUserId: input.senderUserId },
      });
      return false;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(REPLAY_STORE, 'readwrite');
      tx.objectStore(REPLAY_STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    void pruneReplayCache(input.accountId, deviceId).catch(() => undefined);
    return true;
  } catch (error) {
    // Fail open for availability, but log. Decryption auth tag still protects plaintext.
    logCryptoException('anti-replay', error, {
      severity: 'warning',
      myDeviceId: deviceId,
      metadata: { stage: 'mark_seen', messageId: input.messageId },
    });
    return true;
  }
}

async function pruneReplayCache(accountId: string, deviceId: string): Promise<void> {
  const db = await openReplayDB();
  const rows = await new Promise<ReplayRow[]>((resolve, reject) => {
    const tx = db.transaction(REPLAY_STORE, 'readonly');
    const req = tx.objectStore(REPLAY_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []) as ReplayRow[]);
    req.onerror = () => reject(req.error);
  });

  const scoped = rows
    .filter((r) => r.accountId === accountId && r.deviceId === deviceId)
    .sort((a, b) => a.seenAt - b.seenAt);
  if (scoped.length <= MAX_REPLAY_ROWS_PER_DEVICE) return;
  const toDelete = scoped.slice(0, scoped.length - MAX_REPLAY_ROWS_PER_DEVICE);

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(REPLAY_STORE, 'readwrite');
    const store = tx.objectStore(REPLAY_STORE);
    for (const row of toDelete) store.delete(row.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Multi-account isolation guard.
 *
 * A browser can switch accounts. Device/session/ratchet state must not be reused
 * silently across accounts. This guard records the active `(account, device)`
 * tuple and tells the caller when crypto caches should be considered dirty.
 */
export function assertAccountDeviceIsolation(userId: string): { ok: boolean; previous?: string; current: string } {
  const current = `${userId}:${getCurrentDeviceId()}`;
  try {
    const previous = localStorage.getItem(ACCOUNT_DEVICE_KEY) || undefined;
    if (previous && previous !== current) {
      localStorage.setItem(ACCOUNT_DEVICE_KEY, current);
      logCryptoError({
        severity: 'warning',
        context: 'account-isolation',
        errorCode: 'ACCOUNT_DEVICE_SWITCH',
        errorMessage: 'Account/device tuple changed; caller should isolate local crypto caches',
        metadata: { previous, current },
      });
      return { ok: false, previous, current };
    }
    localStorage.setItem(ACCOUNT_DEVICE_KEY, current);
    return { ok: true, previous, current };
  } catch {
    return { ok: true, current };
  }
}
