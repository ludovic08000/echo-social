/**
 * useMessageReactions — Persisted + realtime reactions on messages.
 *
 * - Loads existing reactions for the messages of a conversation.
 * - Subscribes to realtime INSERT/DELETE so peers see updates instantly.
 * - Toggle: clicking the same emoji again removes it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface MessageReaction {
  id: string;
  message_id: string;
  user_id: string;
  emoji: string;
}

export type ReactionsMap = Record<string, MessageReaction[]>;

export function useMessageReactions(conversationId: string | undefined, messageIds: string[]) {
  const { user } = useAuth();
  const [reactions, setReactions] = useState<ReactionsMap>({});

  // Stable key for messageIds to avoid useEffect storms
  const idsKey = useMemo(() => [...messageIds].sort().join(','), [messageIds]);

  // Initial load
  useEffect(() => {
    if (!conversationId || messageIds.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('message_reactions' as any)
        .select('id, message_id, user_id, emoji')
        .in('message_id', messageIds);
      if (cancelled || error || !data) return;
      const map: ReactionsMap = {};
      for (const r of data as unknown as MessageReaction[]) {
        (map[r.message_id] ||= []).push(r);
      }
      setReactions(map);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, idsKey]);

  // Realtime subscription
  useEffect(() => {
    if (!conversationId || messageIds.length === 0) return;
    const ids = new Set(messageIds);
    const channel = supabase
      .channel(`msg-reactions:${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_reactions' },
        payload => {
          const row = payload.new as MessageReaction;
          if (!ids.has(row.message_id)) return;
          setReactions(prev => {
            const list = prev[row.message_id] || [];
            if (list.some(r => r.id === row.id)) return prev;
            return { ...prev, [row.message_id]: [...list, row] };
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'message_reactions' },
        payload => {
          const row = payload.old as MessageReaction;
          setReactions(prev => {
            const list = prev[row.message_id];
            if (!list) return prev;
            return { ...prev, [row.message_id]: list.filter(r => r.id !== row.id) };
          });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, idsKey]);

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!user) return;
    const list = reactions[messageId] || [];
    const existing = list.find(r => r.user_id === user.id && r.emoji === emoji);

    if (existing) {
      // Optimistic remove
      setReactions(prev => ({
        ...prev,
        [messageId]: (prev[messageId] || []).filter(r => r.id !== existing.id),
      }));
      const { error } = await supabase
        .from('message_reactions' as any)
        .delete()
        .eq('id', existing.id);
      if (error) {
        // Rollback
        setReactions(prev => ({
          ...prev,
          [messageId]: [...(prev[messageId] || []), existing],
        }));
      }
    } else {
      // Optimistic add (temp id)
      const tempId = `temp-${crypto.randomUUID()}`;
      const optimistic: MessageReaction = { id: tempId, message_id: messageId, user_id: user.id, emoji };
      setReactions(prev => ({
        ...prev,
        [messageId]: [...(prev[messageId] || []), optimistic],
      }));
      const { data, error } = await supabase
        .from('message_reactions' as any)
        .insert({ message_id: messageId, user_id: user.id, emoji })
        .select('id, message_id, user_id, emoji')
        .single();
      if (error || !data) {
        // Rollback
        setReactions(prev => ({
          ...prev,
          [messageId]: (prev[messageId] || []).filter(r => r.id !== tempId),
        }));
      } else {
        setReactions(prev => ({
          ...prev,
          [messageId]: (prev[messageId] || []).map(r => (r.id === tempId ? (data as unknown as MessageReaction) : r)),
        }));
      }
    }
  }, [user, reactions]);

  return { reactions, toggleReaction };
}
