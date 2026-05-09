/**
 * L2 — Sender Keys rotation watcher.
 *
 * Subscribes to realtime INSERT/DELETE on `conversation_participants` and,
 * whenever membership changes for a conversation where THIS device owns a
 * sender-key chain, rotates that chain. Forward secrecy: a removed member
 * can no longer decrypt future messages, and a freshly-added member only
 * sees messages from the new chain forward.
 *
 * The next outbound send picks up the rotated state via `ensureOwnerSession`
 * and re-fans the SKDM thanks to `invalidateSenderKeysFlag` clearing the
 * snapshot tracker in `senderKeyOutbound`.
 *
 * Idempotent — subscribes once per user. Safe to call on every auth change.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { rotateOwnerSession } from './senderKeySession';
import { invalidateSenderKeysFlag } from './senderKeyOutbound';

const activeWatchers = new Map<string, { refs: number; unsubscribe: () => void }>();

async function ownsChain(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('sender_key_state')
      .select('conversation_id')
      .eq('conversation_id', conversationId)
      .eq('sender_user_id', senderUserId)
      .eq('sender_device_id', senderDeviceId)
      .eq('is_owner', true)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

async function handleMembershipChange(
  conversationId: string,
  senderUserId: string,
): Promise<void> {
  if (!conversationId || !senderUserId) return;
  if (isDeviceIdTemporary()) return;
  const senderDeviceId = getCurrentDeviceId();

  const owns = await ownsChain(conversationId, senderUserId, senderDeviceId);
  if (!owns) return;

  try {
    await rotateOwnerSession(conversationId, senderUserId, senderDeviceId);
    invalidateSenderKeysFlag(conversationId);
    console.info('[SK_ROTATE] chain rotated after membership change', { conversationId });
  } catch (e) {
    console.warn('[SK_ROTATE] rotation failed', { conversationId, e });
  }
}

export function subscribeSenderKeyRotation(userId: string): () => void {
  if (!userId) return () => {};

  const existing = activeWatchers.get(userId);
  if (existing) {
    existing.refs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      existing.refs -= 1;
      if (existing.refs <= 0) {
        existing.unsubscribe();
        activeWatchers.delete(userId);
      }
    };
  }

  const channel = supabase
    .channel(`sk-rotate-${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'conversation_participants' },
      (payload) => {
        const convId = (payload.new as any)?.conversation_id as string | undefined;
        if (convId) void handleMembershipChange(convId, userId);
      },
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'conversation_participants' },
      (payload) => {
        const convId = (payload.old as any)?.conversation_id as string | undefined;
        if (convId) void handleMembershipChange(convId, userId);
      },
    )
    .subscribe();

  const entry = {
    refs: 1,
    unsubscribe: () => {
      try {
        supabase.removeChannel(channel);
      } catch {
        // ignore — channel may already be torn down on hot reload
      }
    },
  };
  activeWatchers.set(userId, entry);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    try {
      entry.unsubscribe();
    } catch {
      // ignore
    }
    activeWatchers.delete(userId);
  };
}
