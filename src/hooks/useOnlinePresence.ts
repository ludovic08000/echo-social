import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useRuntimePrivacyPreferences } from '@/hooks/useRuntimePrivacyPreferences';

const ONLINE_WINDOW_MS = 90_000;
const HEARTBEAT_MS = 30_000;

export function useOnlinePresence() {
  const { user } = useAuth();
  const userId = user?.id;
  const privacy = useRuntimePrivacyPreferences(userId);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const shouldBroadcast = !privacy.ghostMode && privacy.onlineStatusVisibility !== 'nobody';

    const refreshVisiblePresence = async () => {
      const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
      const { data, error } = await supabase
        .from('user_online_presence')
        .select('user_id,last_seen_at')
        .gte('last_seen_at', cutoff);
      if (cancelled || error) return;
      setOnlineUsers(new Set((data || []).map(row => row.user_id)));
    };

    const heartbeat = async () => {
      if (!shouldBroadcast) {
        await supabase.from('user_online_presence').delete().eq('user_id', userId);
        if (!cancelled) setOnlineUsers(prev => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
        return;
      }
      await supabase.from('user_online_presence').upsert({
        user_id: userId,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    };

    const channel = supabase
      .channel(`online-users:${userId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'user_online_presence',
      }, () => { void refreshVisiblePresence(); })
      .subscribe();

    void heartbeat().then(refreshVisiblePresence);
    const heartbeatTimer = window.setInterval(() => {
      void heartbeat().then(refreshVisiblePresence);
    }, HEARTBEAT_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void heartbeat().then(refreshVisiblePresence);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeatTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      supabase.removeChannel(channel);
    };
  }, [privacy.ghostMode, privacy.onlineStatusVisibility, userId]);

  const isOnline = useCallback((userId: string) => onlineUsers.has(userId), [onlineUsers]);

  return { onlineUsers, isOnline };
}
