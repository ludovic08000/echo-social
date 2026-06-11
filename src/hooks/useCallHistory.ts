import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface CallHistoryEntry {
  id: string;
  call_id: string | null;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  call_type: 'audio' | 'video';
  final_status: string;
  duration_seconds: number;
  started_at: string;
  ended_at: string;
  // Hydrated peer info
  peer_name?: string;
  peer_avatar?: string | null;
  peer_id?: string;
  was_missed: boolean;
  is_outgoing: boolean;
}

export function useCallHistory(conversationId?: string, limit = 50) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<CallHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      let q = supabase
        .from('call_history')
        .select('*')
        .or(`caller_id.eq.${user.id},callee_id.eq.${user.id}`)
        .order('ended_at', { ascending: false })
        .limit(limit);
      if (conversationId) q = q.eq('conversation_id', conversationId);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []) as any[];

      // Hydrate peer profiles in one query
      const peerIds = Array.from(new Set(rows.map(r => r.caller_id === user.id ? r.callee_id : r.caller_id)));
      let profiles: Record<string, { name?: string; avatar_url?: string | null }> = {};
      if (peerIds.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('user_id, name, avatar_url')
          .in('user_id', peerIds);
        for (const p of profs || []) profiles[(p as any).user_id] = { name: (p as any).name, avatar_url: (p as any).avatar_url };
      }

      const hydrated: CallHistoryEntry[] = rows.map(r => {
        const isOutgoing = r.caller_id === user.id;
        const peerId = isOutgoing ? r.callee_id : r.caller_id;
        return {
          ...r,
          peer_id: peerId,
          peer_name: profiles[peerId]?.name || 'Utilisateur',
          peer_avatar: profiles[peerId]?.avatar_url ?? null,
          was_missed: !isOutgoing && (r.final_status === 'missed' || r.final_status === 'no_answer' || (r.final_status === 'cancelled' && r.duration_seconds === 0)),
          is_outgoing: isOutgoing,
        } as CallHistoryEntry;
      });
      setEntries(hydrated);
    } finally {
      setLoading(false);
    }
  }, [user?.id, conversationId, limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Realtime — refresh when a new history row arrives for the current user
  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`call-history-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'call_history', filter: `caller_id=eq.${user.id}` },
        () => refresh()
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'call_history', filter: `callee_id=eq.${user.id}` },
        () => refresh()
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, refresh]);

  return { entries, loading, refresh };
}
