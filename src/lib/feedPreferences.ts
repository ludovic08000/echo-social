// ────────────────────────────────────────────────────────
// Feed Preferences — Server-backed (Phase B)
// Stored in `user_feed_preferences` table with RLS + bounds trigger.
// localStorage is kept ONLY as a transient read-cache so existing
// synchronous call sites (usePosts) don't have to await a round-trip.
// All writes go to the DB first; the cache is updated on success.
// ────────────────────────────────────────────────────────

import { supabase } from '@/integrations/supabase/client';
import type { ContentPrefs, FeedWeights } from '@/lib/feedAlgorithm';

const PREFS_KEY = 'content-prefs';
const WEIGHTS_KEY = 'feed-weights';

const DEFAULT_PREFS: ContentPrefs = {
  feedAlgorithm: 'smart',
  diversityBoost: 50,
  mutedKeywords: [],
  priorityTopics: [],
  viralContentReduce: false,
  sensitiveContentFilter: true,
  seenPostsHide: false,
};

const DEFAULT_WEIGHTS: FeedWeights = {
  friends: 60,
  discovery: 30,
  marketplace: 10,
};

type Row = {
  feed_algorithm: 'smart' | 'chronological' | 'friends_first';
  diversity_boost: number;
  muted_keywords: string[];
  priority_topics: string[];
  viral_content_reduce: boolean;
  sensitive_content_filter: boolean;
  seen_posts_hide: boolean;
  weight_friends: number;
  weight_discovery: number;
  weight_marketplace: number;
};

function rowToPrefs(row: Row): { prefs: ContentPrefs; weights: FeedWeights } {
  return {
    prefs: {
      feedAlgorithm: row.feed_algorithm,
      diversityBoost: row.diversity_boost,
      mutedKeywords: row.muted_keywords ?? [],
      priorityTopics: row.priority_topics ?? [],
      viralContentReduce: row.viral_content_reduce,
      sensitiveContentFilter: row.sensitive_content_filter,
      seenPostsHide: row.seen_posts_hide,
    },
    weights: {
      friends: row.weight_friends,
      discovery: row.weight_discovery,
      marketplace: row.weight_marketplace,
    },
  };
}

function writeCache(prefs: ContentPrefs, weights: FeedWeights) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights));
  } catch {}
}

/**
 * Pulls the latest server-side preferences and refreshes the local cache.
 * If no row exists yet, migrates the existing localStorage values to the DB
 * (one-time migration), then re-reads. Safe to call multiple times.
 */
export async function syncFeedPrefsFromServer(userId: string): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('user_feed_preferences' as any)
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) return;

    if (data) {
      const { prefs, weights } = rowToPrefs(data as unknown as Row);
      writeCache(prefs, weights);
      return;
    }

    // No row yet: seed from localStorage if present, else from defaults
    let localPrefs = DEFAULT_PREFS;
    let localWeights = DEFAULT_WEIGHTS;
    try {
      const sp = localStorage.getItem(PREFS_KEY);
      if (sp) localPrefs = { ...DEFAULT_PREFS, ...JSON.parse(sp) };
      const sw = localStorage.getItem(WEIGHTS_KEY);
      if (sw) localWeights = { ...DEFAULT_WEIGHTS, ...JSON.parse(sw) };
    } catch {}

    await supabase.from('user_feed_preferences' as any).upsert({
      user_id: userId,
      feed_algorithm: localPrefs.feedAlgorithm,
      diversity_boost: localPrefs.diversityBoost,
      muted_keywords: localPrefs.mutedKeywords,
      priority_topics: localPrefs.priorityTopics,
      viral_content_reduce: localPrefs.viralContentReduce,
      sensitive_content_filter: localPrefs.sensitiveContentFilter,
      seen_posts_hide: localPrefs.seenPostsHide,
      weight_friends: localWeights.friends,
      weight_discovery: localWeights.discovery,
      weight_marketplace: localWeights.marketplace,
    });

    writeCache(localPrefs, localWeights);
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
  // Read current (cache) to merge
  let currentPrefs = DEFAULT_PREFS;
  let currentWeights = DEFAULT_WEIGHTS;
  try {
    const sp = localStorage.getItem(PREFS_KEY);
    if (sp) currentPrefs = { ...DEFAULT_PREFS, ...JSON.parse(sp) };
    const sw = localStorage.getItem(WEIGHTS_KEY);
    if (sw) currentWeights = { ...DEFAULT_WEIGHTS, ...JSON.parse(sw) };
  } catch {}

  const nextPrefs: ContentPrefs = { ...currentPrefs, ...patch };
  const nextWeights: FeedWeights = patch.weights ? { ...currentWeights, ...patch.weights } : currentWeights;

  const { data, error } = await supabase
    .from('user_feed_preferences' as any)
    .upsert({
      user_id: userId,
      feed_algorithm: nextPrefs.feedAlgorithm,
      diversity_boost: nextPrefs.diversityBoost,
      muted_keywords: nextPrefs.mutedKeywords,
      priority_topics: nextPrefs.priorityTopics,
      viral_content_reduce: nextPrefs.viralContentReduce,
      sensitive_content_filter: nextPrefs.sensitiveContentFilter,
      seen_posts_hide: nextPrefs.seenPostsHide,
      weight_friends: nextWeights.friends,
      weight_discovery: nextWeights.discovery,
      weight_marketplace: nextWeights.marketplace,
    })
    .select('*')
    .maybeSingle();

  if (error) throw error;

  // Use the server-validated row (it may have clamped values)
  if (data) {
    const { prefs, weights } = rowToPrefs(data as unknown as Row);
    writeCache(prefs, weights);
  } else {
    writeCache(nextPrefs, nextWeights);
  }
}
