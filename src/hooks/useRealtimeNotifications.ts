import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useRealtimeNotificationSound } from '@/hooks/useNotificationSounds';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

// Module-level guard: ensure only ONE realtime channel exists per user across the entire app,
// even if the hook is mounted multiple times or re-rendered.
let activeChannelUserId: string | null = null;
const seenNotificationIds = new Set<string>();

type RealtimeNotificationRow = {
  id?: string;
  type?: string;
  actor_id?: string | null;
  metadata?: {
    device_name?: string;
    platform?: string;
  } | null;
};

function notificationSoundCategory(type: string | undefined) {
  if (type === 'message') return 'message';
  if (type === 'friend_request' || type === 'friend_accepted') return 'friend_request';
  if (type === 'comment') return 'comment';
  if (type === 'like' || type === 'reaction') return 'like';
  if (type === 'story_view') return 'story_view';
  if (type === 'close_friend_post') return 'close_friend_post';
  return undefined;
}

/**
 * Global hook: listens for new notifications in realtime and plays a sound.
 * Also plays a sound on initial login if there are unread notifications/messages.
 */
export function useRealtimeNotifications() {
  const { user } = useAuth();
  const userId = user?.id;
  const enqueueSound = useRealtimeNotificationSound();
  const queryClient = useQueryClient();
  const loginSoundPlayed = useRef(false);

  // Play sound on login if unread notifications or messages exist
  useEffect(() => {
    if (!userId || loginSoundPlayed.current) return;
    loginSoundPlayed.current = true;

    const checkUnread = async () => {
      try {
        const [{ data: unreadNotifs }] = await Promise.all([
          supabase
            .from('notifications')
            .select('type')
            .eq('user_id', userId)
            .is('read_at', null)
            .limit(20),
        ]);

        if (unreadNotifs?.length) {
          setTimeout(() => {
            unreadNotifs.forEach((notification) => {
              enqueueSound(notificationSoundCategory(notification.type));
            });
          }, 500);
        }
      } catch {
        // Login remains usable if the best-effort unread check fails.
      }
    };
    checkUnread();
  }, [enqueueSound, userId]);

  // Reset on logout
  useEffect(() => {
    if (!userId) loginSoundPlayed.current = false;
  }, [userId]);

  // Keep latest callbacks in refs so the realtime subscription stays stable
  const enqueueSoundRef = useRef(enqueueSound);
  const queryClientRef = useRef(queryClient);
  useEffect(() => {
    enqueueSoundRef.current = enqueueSound;
    queryClientRef.current = queryClient;
  }, [enqueueSound, queryClient]);

  useEffect(() => {
    if (!userId) return;

    // Guard against double subscription (StrictMode, parallel mounts)
    if (activeChannelUserId === userId) return;
    activeChannelUserId = userId;

    const channel = supabase
      .channel(`global-notifications-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          const row = payload.new as unknown as RealtimeNotificationRow;

          // Dedupe by notification id (Realtime can fire duplicate events on reconnect)
          const notifId: string | undefined = row?.id;
          if (notifId) {
            if (seenNotificationIds.has(notifId)) return;
            seenNotificationIds.add(notifId);
            // Cap memory: keep only last 200 ids
            if (seenNotificationIds.size > 200) {
              const first = seenNotificationIds.values().next().value;
              if (first) seenNotificationIds.delete(first);
            }
          }

          const type: string = row?.type;
          const actorId: string | undefined = row?.actor_id;

          // Fetch sender display name (non-blocking, best-effort)
          let senderName: string | undefined;
          if (actorId) {
            try {
              const { data } = await supabase
                .from('profiles')
                .select('name')
                .eq('user_id', actorId)
                .maybeSingle();
              if (data?.name) senderName = data.name;
            } catch {
              // Sender name is optional; never block the notification itself.
            }
          }

          // Map notification type → sound category
          let category = notificationSoundCategory(type);

          // Special handling: new device linked to account → security toast
          if (type === 'new_device') {
            const meta = row?.metadata ?? {};
            const label = meta.device_name || meta.platform || 'Appareil inconnu';
            toast.warning('Nouvel appareil connecté', {
              description: `${label} vient de se connecter à votre compte. Vérifiez immédiatement.`,
              duration: 10000,
              action: {
                label: 'Vérifier',
                onClick: () => { window.location.href = '/settings?tab=devices'; },
              },
            });
            category = 'friend_request';
          }

          enqueueSoundRef.current(category, senderName);
          queryClientRef.current.invalidateQueries({ queryKey: ['notifications'] });
        }
      )
      .subscribe();

    return () => {
      if (activeChannelUserId === userId) {
        activeChannelUserId = null;
      }
      supabase.removeChannel(channel);
    };
  }, [userId]);
}
