/**
 * useWellbeingPreferences — cloud-synced digital wellbeing settings.
 *
 * Replaces legacy `localStorage['wellbeing-prefs']` with a Supabase-backed
 * `wellbeing_preferences` row keyed by user_id so prefs follow the user
 * across devices. localStorage is kept as a synchronous read-cache so:
 *   - the Feed minute-tick loop reads prefs without an extra round-trip,
 *   - logged-out browsing keeps the last known prefs UX.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface WellbeingPrefs {
  dailyLimitMinutes: number;
  focusModeEnabled: boolean;
  bedtimeReminderEnabled: boolean;
  bedtimeHour: number;
  scrollPauseEnabled: boolean;
  scrollPauseMinutes: number;
  hideLikeCounts: boolean;
  grayscaleAfterLimit: boolean;
}

export const DEFAULT_WELLBEING_PREFS: WellbeingPrefs = {
  dailyLimitMinutes: 60,
  focusModeEnabled: false,
  bedtimeReminderEnabled: false,
  bedtimeHour: 23,
  scrollPauseEnabled: true,
  scrollPauseMinutes: 15,
  hideLikeCounts: false,
  grayscaleAfterLimit: false,
};

const LS_KEY = 'wellbeing-prefs';

export function readLocalWellbeingPrefs(): WellbeingPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_WELLBEING_PREFS;
    return { ...DEFAULT_WELLBEING_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_WELLBEING_PREFS;
  }
}

function writeLocalCache(prefs: WellbeingPrefs) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch {}
}

function rowToPrefs(row: any): WellbeingPrefs {
  return {
    dailyLimitMinutes: Number(row.daily_limit_minutes ?? DEFAULT_WELLBEING_PREFS.dailyLimitMinutes),
    focusModeEnabled: Boolean(row.focus_mode_enabled ?? DEFAULT_WELLBEING_PREFS.focusModeEnabled),
    bedtimeReminderEnabled: Boolean(row.bedtime_reminder_enabled ?? DEFAULT_WELLBEING_PREFS.bedtimeReminderEnabled),
    bedtimeHour: Number(row.bedtime_hour ?? DEFAULT_WELLBEING_PREFS.bedtimeHour),
    scrollPauseEnabled: Boolean(row.scroll_pause_enabled ?? DEFAULT_WELLBEING_PREFS.scrollPauseEnabled),
    scrollPauseMinutes: Number(row.scroll_pause_minutes ?? DEFAULT_WELLBEING_PREFS.scrollPauseMinutes),
    hideLikeCounts: Boolean(row.hide_like_counts ?? DEFAULT_WELLBEING_PREFS.hideLikeCounts),
    grayscaleAfterLimit: Boolean(row.grayscale_after_limit ?? DEFAULT_WELLBEING_PREFS.grayscaleAfterLimit),
  };
}

function prefsToRow(userId: string, prefs: WellbeingPrefs) {
  return {
    user_id: userId,
    daily_limit_minutes: prefs.dailyLimitMinutes,
    focus_mode_enabled: prefs.focusModeEnabled,
    bedtime_reminder_enabled: prefs.bedtimeReminderEnabled,
    bedtime_hour: prefs.bedtimeHour,
    scroll_pause_enabled: prefs.scrollPauseEnabled,
    scroll_pause_minutes: prefs.scrollPauseMinutes,
    hide_like_counts: prefs.hideLikeCounts,
    grayscale_after_limit: prefs.grayscaleAfterLimit,
  };
}

export function useWellbeingPreferences() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<WellbeingPrefs>(() => readLocalWellbeingPrefs());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) { setLoaded(true); return; }
    (async () => {
      const { data, error } = await supabase
        .from('wellbeing_preferences')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!error && data) {
        const remote = rowToPrefs(data);
        setPrefs(remote);
        writeLocalCache(remote);
      } else if (!error && !data) {
        // First time — seed remote from local cache (or defaults).
        const seed = readLocalWellbeingPrefs();
        await supabase
          .from('wellbeing_preferences')
          .upsert(prefsToRow(user.id, seed), { onConflict: 'user_id' });
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Realtime cross-device sync.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase
      .channel(`wellbeing_prefs:${user.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'wellbeing_preferences',
        filter: `user_id=eq.${user.id}`,
      }, (payload: any) => {
        const next = payload.new && Object.keys(payload.new).length
          ? rowToPrefs(payload.new)
          : DEFAULT_WELLBEING_PREFS;
        setPrefs(next);
        writeLocalCache(next);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user?.id]);

  const update = useCallback((patch: Partial<WellbeingPrefs>) => {
    setPrefs(prev => {
      const next = { ...prev, ...patch };
      writeLocalCache(next);
      if (user?.id) {
        void supabase
          .from('wellbeing_preferences')
          .upsert(prefsToRow(user.id, next), { onConflict: 'user_id' });
      }
      return next;
    });
  }, [user?.id]);

  return { prefs, update, loaded };
}
