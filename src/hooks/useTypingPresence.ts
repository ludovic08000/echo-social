import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Real peer "typing" indicator over a Supabase Realtime broadcast channel
 * scoped to a single conversation.
 *
 * Design:
 * - One channel per conversation, name `typing:{conversationId}`.
 * - We broadcast a tiny `{ userId, ts }` payload — never any message content.
 * - Outbound is throttled to at most one broadcast every 2s while the user
 *   keeps typing, plus a final "stop" event when input is cleared / blurred.
 * - Inbound: peer is considered "typing" for 4s after last received event,
 *   auto-clearing via a timer, so a dropped "stop" event never leaves the
 *   indicator stuck.
 */
const THROTTLE_MS = 2000;
const PEER_TIMEOUT_MS = 4000;

export function useTypingPresence(
  conversationId: string | undefined,
  myUserId: string | undefined,
  peerUserId: string | undefined,
) {
  const [peerTyping, setPeerTyping] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastSentRef = useRef<number>(0);
  const peerClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!conversationId || !myUserId) return;

    const channel = supabase.channel(`typing:${conversationId}`, {
      config: { broadcast: { self: false } },
    });

    channel.on('broadcast', { event: 'typing' }, (payload) => {
      const data = payload.payload as { userId?: string; state?: 'start' | 'stop' };
      if (!data?.userId || data.userId === myUserId) return;
      if (peerUserId && data.userId !== peerUserId) return;

      if (data.state === 'stop') {
        if (peerClearTimerRef.current) clearTimeout(peerClearTimerRef.current);
        setPeerTyping(false);
        return;
      }

      setPeerTyping(true);
      if (peerClearTimerRef.current) clearTimeout(peerClearTimerRef.current);
      peerClearTimerRef.current = setTimeout(() => {
        setPeerTyping(false);
      }, PEER_TIMEOUT_MS);
    });

    channel.subscribe();
    channelRef.current = channel;

    return () => {
      if (peerClearTimerRef.current) clearTimeout(peerClearTimerRef.current);
      peerClearTimerRef.current = null;
      supabase.removeChannel(channel);
      channelRef.current = null;
      setPeerTyping(false);
      lastSentRef.current = 0;
    };
  }, [conversationId, myUserId, peerUserId]);

  /** Call on every keystroke; internally throttled. */
  const notifyTyping = useCallback(() => {
    const ch = channelRef.current;
    if (!ch || !myUserId) return;
    const now = Date.now();
    if (now - lastSentRef.current < THROTTLE_MS) return;
    lastSentRef.current = now;
    ch.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: myUserId, state: 'start', ts: now },
    });
  }, [myUserId]);

  /** Call when user clears input, sends, or blurs. */
  const notifyStopped = useCallback(() => {
    const ch = channelRef.current;
    if (!ch || !myUserId) return;
    lastSentRef.current = 0;
    ch.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: myUserId, state: 'stop', ts: Date.now() },
    });
  }, [myUserId]);

  return { peerTyping, notifyTyping, notifyStopped };
}
