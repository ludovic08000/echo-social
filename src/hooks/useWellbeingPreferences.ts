/**
 * useWellbeingPreferences — cloud-synced digital wellbeing settings.
 *
 * Replaces legacy `localStorage['wellbeing-prefs']` with a Supabase-backed
 * `wellbeing_preferences` row keyed by user_id so prefs follow the user
 * across devices. localStorage is kept as a synchronous read-cache so:
 *   - the Feed minute-tick loop reads prefs without an extra round-trip,
 *   - logged-out browsing keeps the last known prefs UX.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
const LS_OWNER_KEY = 'wellbeing-prefs-user';
export const WELLBEING_CHANGED_EVENT = 'forsure:wellbeing-changed';

export function readLocalWellbeingPrefs(userId?: string): WellbeingPrefs {
  try {
    const cacheOwner = localStorage.getItem(LS_OWNER_KEY);
    if (userId && cacheOwner && cacheOwner !== userId) return DEFAULT_WELLBEING_PREFS;
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_WELLBEING_PREFS;
    return { ...DEFAULT_WELLBEING_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_WELLBEING_PREFS;
  }
}

function writeLocalCache(prefs: WellbeingPrefs, userId?: string) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    if (userId) localStorage.setItem(LS_OWNER_KEY, userId);
  } catch {
    // The cloud row remains authoritative when storage is unavailable.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(WELLBEING_CHANGED_EVENT, { detail: prefs }));
  }
}

type WellbeingRow = {
  daily_limit_minutes?: number | null;
  focus_mode_enabled?: boolean | null;
  bedtime_reminder_enabled?: boolean | null;
  bedtime_hour?: number | null;
  scroll_pause_enabled?: boolean | null;
  scroll_pause_minutes?: number | null;
  hide_like_counts?: boolean | null;
  grayscale_after_limit?: boolean | null;
};

function rowToPrefs(row: WellbeingRow): WellbeingPrefs {
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
  const userId = user?.id;
  const [prefs, setPrefs] = useState<WellbeingPrefs>(() => readLocalWellbeingPrefs());
  const prefsRef = useRef(prefs);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    if (!userId) {
      setLoaded(true);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('wellbeing_preferences')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (cancelled) return;
      if (!error && data) {
        const remote = rowToPrefs(data as WellbeingRow);
        prefsRef.current = remote;
        setPrefs(remote);
        writeLocalCache(remote, userId);
      } else if (!error && !data) {
        // First time — seed remote from local cache (or defaults).
        const seed = readLocalWellbeingPrefs(userId);
        prefsRef.current = seed;
        setPrefs(seed);
        await supabase
          .from('wellbeing_preferences')
          .upsert(prefsToRow(userId, seed), { onConflict: 'user_id' });
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<WellbeingPrefs>).detail;
      if (next) {
        prefsRef.current = next;
        setPrefs(next);
      }
    };
    window.addEventListener(WELLBEING_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(WELLBEING_CHANGED_EVENT, onChanged);
  }, []);

  // Realtime cross-device sync.
  useEffect(() => {
    if (!userId) return;
    const ch = supabase
      .channel(`wellbeing_prefs:${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'wellbeing_preferences',
        filter: `user_id=eq.${userId}`,
      }, (payload) => {
        const next = payload.new && Object.keys(payload.new).length
          ? rowToPrefs(payload.new as WellbeingRow)
          : DEFAULT_WELLBEING_PREFS;
        prefsRef.current = next;
        setPrefs(next);
        writeLocalCache(next, userId);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [userId]);

  const update = useCallback((patch: Partial<WellbeingPrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefs(next);
    writeLocalCache(next, userId);
    if (userId) {
      void supabase
        .from('wellbeing_preferences')
        .upsert(prefsToRow(userId, next), { onConflict: 'user_id' });
    }
  }, [userId]);

  return { prefs, update, loaded };
}
