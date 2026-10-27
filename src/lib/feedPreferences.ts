// ────────────────────────────────────────────────────────
// Feed Preferences — Server-backed (Phase B)
// Stored in `user_feed_preferences` table with RLS + bounds trigger.
// localStorage is kept ONLY as a transient read-cache so existing
// synchronous call sites (usePosts) don't have to await a round-trip.
// All writes go to the DB first; the cache is updated on success.
// ────────────────────────────────────────────────────────

import { readFeedPreferences, writeFeedPreferences } from '@/lib/feedApi';
import { supabase } from '@/integrations/supabase/client';
import type { ContentPrefs, FeedWeights } from '@/lib/feedAlgorithm';
import type { FeedPreferenceCommand } from '@/lib/feedControlActions';

const PREFS_KEY = 'content-prefs';
const WEIGHTS_KEY = 'feed-weights';
const CACHE_OWNER_KEY = 'feed-prefs-user';
export const CONTENT_PREFS_CHANGED_EVENT = 'forsure:content-prefs-changed';

const DEFAULT_PREFS: ContentPrefs = {
  feedAlgorithm: 'smart',
  aiSummariesEnabled: true,
  autoTranslateEnabled: false,
  diversityBoost: 50,
  mutedKeywords: [],
  priorityTopics: [],
  reducedTopics: [],
  viralContentReduce: false,
  sensitiveContentFilter: true,
  seenPostsHide: false,
};

const DEFAULT_WEIGHTS: FeedWeights = {
  friends: 60,
  discovery: 30,
  news: 30,
  marketplace: 10,
};

type Row = {
  feed_algorithm: 'smart' | 'chronological' | 'friends_first';
  ai_summaries_enabled?: boolean;
  auto_translate_enabled?: boolean;
  diversity_boost: number;
  muted_keywords: string[];
  priority_topics: string[];
  reduced_topics?: string[];
  viral_content_reduce: boolean;
  sensitive_content_filter: boolean;
  seen_posts_hide: boolean;
  weight_friends: number;
  weight_discovery: number;
  weight_news?: number;
  weight_marketplace: number;
};

function rowToPrefs(row: Row): { prefs: ContentPrefs; weights: FeedWeights } {
  return {
    prefs: {
      feedAlgorithm: row.feed_algorithm,
      aiSummariesEnabled: row.ai_summaries_enabled ?? true,
      autoTranslateEnabled: row.auto_translate_enabled ?? false,
      diversityBoost: row.diversity_boost,
      mutedKeywords: row.muted_keywords ?? [],
      priorityTopics: row.priority_topics ?? [],
      reducedTopics: row.reduced_topics ?? [],
      viralContentReduce: row.viral_content_reduce,
      sensitiveContentFilter: row.sensitive_content_filter,
      seenPostsHide: row.seen_posts_hide,
    },
    weights: {
      friends: row.weight_friends,
      discovery: row.weight_discovery,
      news: row.weight_news ?? 30,
      marketplace: row.weight_marketplace,
    },
  };
}

function writeCache(prefs: ContentPrefs, weights: FeedWeights, userId?: string) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights));
    if (userId) localStorage.setItem(CACHE_OWNER_KEY, userId);
    window.dispatchEvent(new CustomEvent(CONTENT_PREFS_CHANGED_EVENT, { detail: prefs }));
  } catch {
    // Server persistence still works when local cache storage is unavailable.
  }
}

/**
 * Pulls the latest server-side preferences and refreshes the local cache.
 * If no row exists yet, migrates the existing localStorage values to the DB
 * (one-time migration), then re-reads. Safe to call multiple times.
 */
export async function syncFeedPrefsFromServer(userId: string): Promise<void> {
  try {
    const data = await readFeedPreferences(userId);

    if (data) {
      const { prefs, weights } = rowToPrefs(data as unknown as Row);
      writeCache(prefs, weights, userId);
      return;
    }

    // No row yet: seed from localStorage if present, else from defaults
    let localPrefs = DEFAULT_PREFS;
    let localWeights = DEFAULT_WEIGHTS;
    try {
      const cacheOwner = localStorage.getItem(CACHE_OWNER_KEY);
      const canMigrateCache = !cacheOwner || cacheOwner === userId;
      if (canMigrateCache) {
        const sp = localStorage.getItem(PREFS_KEY);
        if (sp) localPrefs = { ...DEFAULT_PREFS, ...JSON.parse(sp) };
        const sw = localStorage.getItem(WEIGHTS_KEY);
        if (sw) localWeights = { ...DEFAULT_WEIGHTS, ...JSON.parse(sw) };
      }
    } catch {
      // Fall back to defaults when the legacy cache cannot be read.
    }

    const saved = await writeFeedPreferences(userId, {
      feed_algorithm: localPrefs.feedAlgorithm,
      ai_summaries_enabled: localPrefs.aiSummariesEnabled,
      auto_translate_enabled: localPrefs.autoTranslateEnabled,
      diversity_boost: localPrefs.diversityBoost,
      muted_keywords: localPrefs.mutedKeywords,
      priority_topics: localPrefs.priorityTopics,
      reduced_topics: localPrefs.reducedTopics,
      viral_content_reduce: localPrefs.viralContentReduce,
      sensitive_content_filter: localPrefs.sensitiveContentFilter,
      seen_posts_hide: localPrefs.seenPostsHide,
      weight_friends: localWeights.friends,
      weight_discovery: localWeights.discovery,
      weight_news: localWeights.news,
      weight_marketplace: localWeights.marketplace,
    }, true);

    const { prefs, weights } = rowToPrefs(saved);
    writeCache(prefs, weights, userId);
  } catch {
    // Network/offline: keep current cache
  }
}

/**
 * Persists a partial update server-side. Bounds and whitelist are enforced
 * by the DB trigger — the client cannot inject out-of-range values.
 * On success, also refreshes the local cache so synchronous reads stay in sync.
 */
export async function saveFeedPrefs(
  userId: string,
  patch: Partial<ContentPrefs> & Partial<{ weights: FeedWeights }>,
): Promise<void> {
  // Merge against this account's server row. A failed read must not overwrite
  // saved choices with defaults or another account's local cache.
  const serverRow = await readFeedPreferences(userId);
  const { prefs: currentPrefs, weights: currentWeights } = serverRow
    ? rowToPrefs(serverRow) : { prefs: DEFAULT_PREFS, weights: DEFAULT_WEIGHTS };

  const nextPrefs: ContentPrefs = { ...currentPrefs, ...patch };
  const nextWeights: FeedWeights = patch.weights ? { ...currentWeights, ...patch.weights } : currentWeights;

  const data = await writeFeedPreferences(userId, {
      feed_algorithm: nextPrefs.feedAlgorithm,
      ai_summaries_enabled: nextPrefs.aiSummariesEnabled,
      auto_translate_enabled: nextPrefs.autoTranslateEnabled,
      diversity_boost: nextPrefs.diversityBoost,
      muted_keywords: nextPrefs.mutedKeywords,
      priority_topics: nextPrefs.priorityTopics,
      reduced_topics: nextPrefs.reducedTopics,
      viral_content_reduce: nextPrefs.viralContentReduce,
      sensitive_content_filter: nextPrefs.sensitiveContentFilter,
      seen_posts_hide: nextPrefs.seenPostsHide,
      weight_friends: nextWeights.friends,
      weight_discovery: nextWeights.discovery,
      weight_news: nextWeights.news,
      weight_marketplace: nextWeights.marketplace,
    });

  // Use the server-validated row (it may have clamped values)
  if (data) {
    const { prefs, weights } = rowToPrefs(data as unknown as Row);
    writeCache(prefs, weights, userId);
  } else {
    writeCache(nextPrefs, nextWeights, userId);
  }
}

export async function applyFeedPreferenceCommand(
  summary: string,
  command: FeedPreferenceCommand,
): Promise<string> {
  const { data, error } = await supabase.rpc('apply_feed_preference_command' as any, {
    p_summary: summary,
    p_command: command,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.change_id) throw new Error('FEED_CHANGE_NOT_APPLIED');
  return String(row.change_id);
}

export async function undoFeedPreferenceChange(changeId: string): Promise<void> {
  const { error } = await supabase.rpc('undo_feed_preference_change' as any, {
    p_change_id: changeId,
  });
  if (error) throw error;
}
