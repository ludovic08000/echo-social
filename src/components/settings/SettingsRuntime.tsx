import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Shield, TimerReset } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { useAccessibilityPreferences } from '@/hooks/useAccessibilityPreferences';
import { useWellbeingPreferences } from '@/hooks/useWellbeingPreferences';
import { usePrivacySettings } from '@/hooks/usePrivacySettings';
import { getTodayMinutes } from '@/lib/feedAlgorithm';
import { isBedtimeHour, isDetoxScheduleActive, type DetoxSchedule } from '@/lib/wellbeingRuntime';

const DETOX_BYPASS_KEY = 'forsure:detox-bypass-until';

function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element?.closest('input, textarea, select, [contenteditable="true"]');
}

export function SettingsRuntime() {
  const navigate = useNavigate();
  const location = useLocation();
  const accessibility = useAccessibilityPreferences();
  const { prefs: wellbeing } = useWellbeingPreferences();
  const { data: privacy } = usePrivacySettings();
  const [now, setNow] = useState(() => new Date());
  const [detoxBypassUntil, setDetoxBypassUntil] = useState(() =>
    Number(sessionStorage.getItem(DETOX_BYPASS_KEY) || '0')
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const overDailyLimit = getTodayMinutes() >= wellbeing.dailyLimitMinutes;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('wellbeing-hide-counts', wellbeing.hideLikeCounts);
    root.classList.toggle('wellbeing-focus-mode', wellbeing.focusModeEnabled);
    root.classList.toggle(
      'wellbeing-grayscale',
      wellbeing.grayscaleAfterLimit && overDailyLimit,
    );
    return () => {
      root.classList.remove('wellbeing-hide-counts', 'wellbeing-focus-mode', 'wellbeing-grayscale');
    };
  }, [wellbeing.focusModeEnabled, wellbeing.grayscaleAfterLimit, wellbeing.hideLikeCounts, overDailyLimit]);

  useEffect(() => {
    if (!wellbeing.bedtimeReminderEnabled || !isBedtimeHour(wellbeing.bedtimeHour, now)) return;
    const dayKey = `forsure:bedtime-reminder:${now.toISOString().slice(0, 10)}`;
    if (localStorage.getItem(dayKey)) return;
    localStorage.setItem(dayKey, '1');
    toast({
      title: 'Il est temps de faire une pause',
      description: 'Votre rappel de coucher est actif. Vous pourrez reprendre demain.',
    });
  }, [now, wellbeing.bedtimeHour, wellbeing.bedtimeReminderEnabled]);

  useEffect(() => {
    if (!accessibility.keyboardNavigation) return;
    let pendingGo = false;
    let pendingTimer = 0;

    const selectPost = (direction: 1 | -1) => {
      const posts = Array.from(document.querySelectorAll<HTMLElement>('[data-post-card]'));
      if (!posts.length) return;
      const current = posts.findIndex((post) => {
        const rect = post.getBoundingClientRect();
        return rect.top <= window.innerHeight / 2 && rect.bottom >= window.innerHeight / 2;
      });
      const index = Math.min(posts.length - 1, Math.max(0, (current < 0 ? 0 : current) + direction));
      posts[index]?.focus({ preventScroll: true });
      posts[index]?.scrollIntoView({ behavior: accessibility.reducedMotion ? 'auto' : 'smooth', block: 'center' });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'g') {
        pendingGo = true;
        window.clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(() => { pendingGo = false; }, 1_200);
        return;
      }
      if (pendingGo) {
        pendingGo = false;
        window.clearTimeout(pendingTimer);
        const destinations: Record<string, string> = {
          h: '/feed', p: '/profile', m: '/messages', n: '/notifications',
        };
        if (destinations[key]) {
          event.preventDefault();
          navigate(destinations[key]);
        }
        return;
      }
      if (key === 'n') { event.preventDefault(); navigate('/create'); }
      else if (key === '/' || key === 's') { event.preventDefault(); navigate('/search'); }
      else if (key === 'j') { event.preventDefault(); selectPost(1); }
      else if (key === 'k') { event.preventDefault(); selectPost(-1); }
      else if (key === 'l') {
        (document.activeElement?.closest('[data-post-card]')?.querySelector('[data-post-like] button') as HTMLButtonElement | null)?.click();
      } else if (key === 'c') {
        (document.activeElement?.closest('[data-post-card]')?.querySelector('[data-post-comment]') as HTMLButtonElement | null)?.click();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(pendingTimer);
    };
  }, [accessibility.keyboardNavigation, accessibility.reducedMotion, navigate]);

  const detoxActive = useMemo(
    () => isDetoxScheduleActive(privacy?.detox_schedule as DetoxSchedule | null, now),
    [now, privacy?.detox_schedule],
  );
  const showDetox = detoxActive
    && Date.now() >= detoxBypassUntil
    && location.pathname !== '/settings';

  if (!showDetox) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 p-6 backdrop-blur-xl" role="dialog" aria-modal="true" aria-labelledby="detox-title">
      <div className="w-full max-w-sm space-y-5 rounded-3xl border border-primary/20 bg-card p-6 text-center shadow-2xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <Shield className="h-7 w-7 text-primary" />
        </div>
        <div>
          <h2 id="detox-title" className="text-xl font-bold">Détox digitale en cours</h2>
          <p className="mt-2 text-sm text-muted-foreground">Cette plage de pause a été programmée dans vos réglages Bien-être.</p>
        </div>
        <Button className="w-full" onClick={() => navigate('/settings?tab=wellbeing')}>
          Gérer le programme
        </Button>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            const until = Date.now() + 15 * 60_000;
            sessionStorage.setItem(DETOX_BYPASS_KEY, String(until));
            setDetoxBypassUntil(until);
          }}
        >
          <TimerReset className="mr-2 h-4 w-4" /> Pause de 15 minutes
        </Button>
      </div>
    </div>
  );
}
