import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { useConversations } from '@/hooks/useMessages';
import { useNotifications } from '@/hooks/useNotifications';
import { useWellbeingPreferences } from '@/hooks/useWellbeingPreferences';
import { buildZeusBreakReminder, buildZeusLoginBriefing } from '@/lib/zeusProactive';

const ACTIVE_TICK_MS = 15_000;

function openZeusWithMessage(content: string) {
  window.dispatchEvent(new CustomEvent('open-zeus', {
    detail: { proactiveMessage: content },
  }));
}

export function useZeusProactiveAssistant() {
  const { user, session } = useAuth();
  const { data: conversations, isSuccess: conversationsReady } = useConversations();
  const { data: notifications, isSuccess: notificationsReady } = useNotifications();
  const { prefs, loaded: preferencesReady } = useWellbeingPreferences();
  const lastTickRef = useRef(Date.now());
  const briefingDeliveredRef = useRef<string | null>(null);
  const previousUserRef = useRef<string | null>(null);

  const unreadMessages = useMemo(
    () => conversations?.reduce((sum, conversation) => sum + conversation.unread_count, 0) ?? 0,
    [conversations],
  );
  const unreadNotifications = useMemo(
    () => notifications?.filter((notification) => notification.read_at === null) ?? [],
    [notifications],
  );

  // One briefing per authenticated session. No notification is marked as read.
  useEffect(() => {
    if (!user?.id || !session?.access_token || !conversationsReady || !notificationsReady) return;
    const marker = `forsure:zeus-briefing:${user.id}`;
    if (briefingDeliveredRef.current === user.id) return;
    try {
      if (sessionStorage.getItem(marker)) return;
      sessionStorage.setItem(marker, '1');
    } catch {
      // Storage can be unavailable in private mode; the in-memory React effect
      // still prevents repeats during this mount.
    }
    briefingDeliveredRef.current = user.id;

    const content = buildZeusLoginBriefing({ unreadMessages, unreadNotifications });
    if (!content) return;
    toast.info('Zeus', {
      id: marker,
      description: content,
      duration: 9_000,
      action: { label: 'Voir', onClick: () => openZeusWithMessage(content) },
    });
  }, [conversationsReady, notificationsReady, session?.access_token, unreadMessages, unreadNotifications, user?.id]);

  // A real sign-out ends the briefing session; a token refresh does not.
  useEffect(() => {
    if (user?.id) {
      previousUserRef.current = user.id;
      return;
    }
    const previousUser = previousUserRef.current;
    if (!previousUser) return;
    try { sessionStorage.removeItem(`forsure:zeus-briefing:${previousUser}`); } catch {}
    briefingDeliveredRef.current = null;
    previousUserRef.current = null;
  }, [user?.id]);

  // Count only foreground time. A hidden/background tab contributes nothing.
  useEffect(() => {
    if (!user?.id || !preferencesReady || !prefs.scrollPauseEnabled) return;
    const thresholdMinutes = Math.max(1, prefs.scrollPauseMinutes);
    const storageKey = `forsure:zeus-active-ms:${user.id}`;

    const readActiveMs = () => {
      try { return Math.max(0, Number(sessionStorage.getItem(storageKey)) || 0); }
      catch { return 0; }
    };
    let activeMs = readActiveMs();
    lastTickRef.current = Date.now();

    const tick = () => {
      const now = Date.now();
      const elapsed = Math.min(now - lastTickRef.current, ACTIVE_TICK_MS * 2);
      lastTickRef.current = now;
      if (document.visibilityState !== 'visible') return;

      activeMs += Math.max(0, elapsed);
      const thresholdMs = thresholdMinutes * 60_000;
      if (activeMs < thresholdMs) {
        try { sessionStorage.setItem(storageKey, String(activeMs)); } catch {}
        return;
      }

      activeMs %= thresholdMs;
      try { sessionStorage.setItem(storageKey, String(activeMs)); } catch {}
      const content = buildZeusBreakReminder(thresholdMinutes);
      toast.info('Zeus · Bien-être', {
        id: `zeus-break-${user.id}`,
        description: content,
        duration: 12_000,
        action: { label: 'Parler à Zeus', onClick: () => openZeusWithMessage(content) },
      });
    };

    const onVisibilityChange = () => { lastTickRef.current = Date.now(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(tick, ACTIVE_TICK_MS);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [preferencesReady, prefs.scrollPauseEnabled, prefs.scrollPauseMinutes, user?.id]);
}

