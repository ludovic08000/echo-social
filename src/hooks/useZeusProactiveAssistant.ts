import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { useConversations } from '@/hooks/useMessages';
import { useNotifications } from '@/hooks/useNotifications';
import { useWellbeingPreferences } from '@/hooks/useWellbeingPreferences';
import { useVoiceSettings } from '@/hooks/useVoiceSettings';
import { useZeusSettings } from '@/hooks/useZeusCompanion';
import { buildZeusBreakReminder, buildZeusLoginBriefing } from '@/lib/zeusProactive';
import {
  isZeusVoiceUnlockedForSession,
  savePendingZeusAnnouncement,
  speakWithBrowserVoice,
  unlockZeusVoiceForSession,
} from '@/lib/zeusVoice';

const ACTIVE_TICK_MS = 15_000;
function readyAnnouncement(assistantName: string) {
  return `Bonjour, je suis ${assistantName}. Je suis prêt à vous aider.`;
}

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
  const { voiceSettings, updateVoiceSettings } = useVoiceSettings();
  const { zeusName } = useZeusSettings();
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

    const content = buildZeusLoginBriefing({ unreadMessages, unreadNotifications })
      ?? readyAnnouncement(zeusName);
    savePendingZeusAnnouncement(content);

    // An earlier explicit gesture in this browser session can safely allow a
    // spoken summary. A persisted setting alone is deliberately insufficient:
    // Safari/iOS requires a gesture in the current page lifecycle.
    if (
      voiceSettings.voice_enabled
      && isZeusVoiceUnlockedForSession()
      && document.visibilityState === 'visible'
    ) {
      speakWithBrowserVoice(content, {
        lang: voiceSettings.voice_lang,
        rate: voiceSettings.voice_speed,
        volume: voiceSettings.voice_volume,
      });
      return;
    }

    toast.info(zeusName, {
      id: marker,
      description: content,
      duration: 12_000,
      action: {
        label: 'Activer la voix',
        onClick: () => {
          updateVoiceSettings({ voice_enabled: true });
          unlockZeusVoiceForSession();
          const started = speakWithBrowserVoice(content, {
            lang: voiceSettings.voice_lang,
            rate: voiceSettings.voice_speed,
            volume: voiceSettings.voice_volume,
          });
          if (!started) {
            toast.error('La synthèse vocale n’est pas disponible dans ce navigateur.');
          }
        },
      },
    });
  }, [
    conversationsReady,
    notificationsReady,
    session?.access_token,
    unreadMessages,
    unreadNotifications,
    updateVoiceSettings,
    user?.id,
    zeusName,
    voiceSettings.voice_enabled,
    voiceSettings.voice_lang,
    voiceSettings.voice_speed,
    voiceSettings.voice_volume,
  ]);

  // A real sign-out ends the briefing session; a token refresh does not.
  useEffect(() => {
    if (user?.id) {
      previousUserRef.current = user.id;
      return;
    }
    const previousUser = previousUserRef.current;
    if (!previousUser) return;
    try { sessionStorage.removeItem(`forsure:zeus-briefing:${previousUser}`); } catch {
      // Private browsing can reject session storage; the in-memory guard remains.
    }
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
        try { sessionStorage.setItem(storageKey, String(activeMs)); } catch {
          // The active-session reminder still works without session storage.
        }
        return;
      }

      activeMs %= thresholdMs;
      try { sessionStorage.setItem(storageKey, String(activeMs)); } catch {
        // The active-session reminder still works without session storage.
      }
      const content = buildZeusBreakReminder(thresholdMinutes);
      if (
        voiceSettings.voice_enabled
        && isZeusVoiceUnlockedForSession()
        && document.visibilityState === 'visible'
      ) {
        speakWithBrowserVoice(content, {
          lang: voiceSettings.voice_lang,
          rate: voiceSettings.voice_speed,
          volume: voiceSettings.voice_volume,
        });
      }
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
  }, [
    preferencesReady,
    prefs.scrollPauseEnabled,
    prefs.scrollPauseMinutes,
    user?.id,
    voiceSettings.voice_enabled,
    voiceSettings.voice_lang,
    voiceSettings.voice_speed,
    voiceSettings.voice_volume,
  ]);
}

