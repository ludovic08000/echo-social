/**
 * Refanout queue — Signal-style "ask the sender to re-emit my device copy".
 *
 * Triggered by `messageRouter` when an inbound envelope fails to decrypt
 * persistently (≥ N consecutive attempts). We call the SECURITY DEFINER RPC
 * `request_message_refanout` which enqueues a retry on `device_copy_retry_requests`.
 * The sender's `deviceCopyRetryProcessor` picks it up and re-encrypts the same
 * message for our device against the freshly published prekey bundle.
 *
 * Plaintext NEVER reaches Supabase. The server only sees opaque message IDs.
 *
 * Bounded in-RAM state:
 *   - per-messageId failure counter (cleared on success or after TTL)
 *   - per-messageId "already requested" marker (TTL 5 min) to prevent floods
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';

const FAIL_THRESHOLD = 2;
const STATE_TTL_MS = 10 * 60 * 1000;
const REQUESTED_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

type Entry = { fails: number; firstAt: number; requestedAt?: number };
const state = new Map<string, Entry>();

function gc(): void {
  const now = Date.now();
  if (state.size < MAX_ENTRIES) {
    for (const [k, v] of state) {
      if (now - v.firstAt > STATE_TTL_MS) state.delete(k);
    }
    return;
  }
  // Hard cap reached — drop oldest half.
  const entries = [...state.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt);
  for (let i = 0; i < entries.length / 2; i++) state.delete(entries[i][0]);
}

/**
 * Note a decrypt failure for a messageId. When the count reaches FAIL_THRESHOLD
 * and we know the sender, fire a refanout request. Returns true if a request
 * was actually dispatched (caller may want to avoid markSeenMessage so the
 * next resume retries with the new copy).
 */
export async function noteDecryptFailure(
  messageId: string | undefined,
  senderUserId: string | undefined,
): Promise<boolean> {
  if (!messageId || !senderUserId) return false;
  if (isDeviceIdTemporary()) return false;

  gc();
  const now = Date.now();
  let entry = state.get(messageId);
  if (!entry) {
    entry = { fails: 0, firstAt: now };
    state.set(messageId, entry);
  }
  entry.fails += 1;

  if (entry.fails < FAIL_THRESHOLD) return false;
  if (entry.requestedAt && now - entry.requestedAt < REQUESTED_TTL_MS) return false;

  const myDeviceId = (() => {
    try { return getCurrentDeviceId(); } catch { return null; }
  })();
  if (!myDeviceId) return false;

  return requestRefanout(messageId, senderUserId, myDeviceId).then((ok) => {
    if (ok) entry!.requestedAt = now;
    return ok;
  });
}

/** Reset failure tracking for a messageId after a successful decrypt. */
export function clearDecryptFailure(messageId: string | undefined): void {
  if (!messageId) return;
  state.delete(messageId);
}

/** Low-level RPC call. Exposed for callers that already know they want a refanout. */
export async function requestRefanout(
  messageId: string,
  senderUserId: string,
  requesterDeviceId: string,
): Promise<boolean> {
  try {
    const { data, error } = await (supabase as any).rpc('request_message_refanout', {
      p_message_id: messageId,
      p_sender_user_id: senderUserId,
      p_requester_device_id: requesterDeviceId,
    });
    if (error) {
      console.warn('[REFANOUT] RPC failed', { messageId, error: error.message });
      return false;
    }
    const result = data as { ok?: boolean; code?: string } | null;
    if (result?.ok === false || result?.code === 'RETRY_BUDGET_EXHAUSTED' || result?.code === 'RETRY_ALREADY_DONE') {
      console.info('[REFANOUT] not queued', { messageId: messageId.slice(0, 8), code: result.code });
      return false;
    }
    console.info('[REFANOUT] requested', { messageId: messageId.slice(0, 8) });
    return true;
  } catch (e) {
    console.warn('[REFANOUT] unexpected error', e);
    return false;
  }
}
