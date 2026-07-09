// ────────────────────────────────────────────────────────
// Feed Algorithm — Thin client shim (Phase 4)
// All ranking now happens server-side via `feed_score_batch` RPC
// (see Postgres migration + src/lib/feedPreferences.ts).
//
// This file only keeps:
//  • Types shared with settings UI (ContentPrefs, FeedWeights)
//  • Synchronous localStorage cache readers (mirror of DB prefs)
//  • Pure helpers still used outside ranking (muted keywords filter,
//    notifications grouping, marketplace rotation, wellbeing tracking)
//
// All previous Monte Carlo / Wilson / Thompson sampling / scorePost
// functions have been removed — they lived client-side and were
// gameable. The server is the single source of truth.
// ────────────────────────────────────────────────────────

export interface ContentPrefs {
  feedAlgorithm: 'smart' | 'chronological' | 'friends_first';
  diversityBoost: number; // 0-100
  mutedKeywords: string[];
  priorityTopics: string[];
  viralContentReduce: boolean;
  sensitiveContentFilter: boolean;
  seenPostsHide: boolean;
}

export interface FeedWeights {
  friends: number;     // 0-100
  discovery: number;   // 0-100
  marketplace: number; // 0-100
}

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

/**
 * Synchronous read of cached prefs (populated from the DB by
 * `syncFeedPrefsFromServer` in feedPreferences.ts). Safe to call
 * anywhere; falls back to defaults when no cache exists.
 */
export function loadContentPrefs(): ContentPrefs {
  try {
    const saved = localStorage.getItem('content-prefs');
    return saved ? { ...DEFAULT_PREFS, ...JSON.parse(saved) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function loadFeedWeights(): FeedWeights {
  try {
    const saved = localStorage.getItem('feed-weights');
    return saved ? { ...DEFAULT_WEIGHTS, ...JSON.parse(saved) } : DEFAULT_WEIGHTS;
  } catch {
    return DEFAULT_WEIGHTS;
  }
}

/** Muted-keyword filter (case-insensitive substring match). */
export function containsMutedKeyword(text: string, keywords: string[]): boolean {
  if (!keywords || keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

// ── Fair marketplace rotation ──
export function rotateMarketplaceProducts<T extends { seller_id: string; created_at: string; order_count: number; view_count: number }>(
  products: T[],
  pageIndex: number = 0,
): T[] {
  if (products.length === 0) return [];
  const sellerGroups = new Map<string, T[]>();
  products.forEach(p => {
    const group = sellerGroups.get(p.seller_id) || [];
    group.push(p);
    sellerGroups.set(p.seller_id, group);
  });
  const sellers = Array.from(sellerGroups.keys());
  const hourOfDay = new Date().getHours();
  const offset = (hourOfDay + pageIndex) % Math.max(1, sellers.length);
  const rotatedSellers = [...sellers.slice(offset), ...sellers.slice(0, offset)];
  const result: T[] = [];
  let maxDepth = 0;
  rotatedSellers.forEach(s => { maxDepth = Math.max(maxDepth, sellerGroups.get(s)!.length); });
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const seller of rotatedSellers) {
      const group = sellerGroups.get(seller)!;
      if (depth < group.length) result.push(group[depth]);
    }
  }
  return result;
}

// ── Smart notification grouping (pure UI helper) ──
export interface GroupedNotification {
  type: string;
  postId: string | null;
  actors: { id: string; name: string; avatar_url: string | null }[];
  latestAt: string;
  count: number;
  readAt: string | null;
}

export function groupNotifications(
  notifications: Array<{
    id: string;
    type: string;
    actor_id: string;
    post_id: string | null;
    read_at: string | null;
    created_at: string;
    actor: { name: string; avatar_url: string | null };
  }>,
): GroupedNotification[] {
  const groups = new Map<string, GroupedNotification>();
  for (const n of notifications) {
    const key = `${n.type}:${n.post_id || 'none'}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.actors.find(a => a.id === n.actor_id)) {
        existing.actors.push({ id: n.actor_id, name: n.actor.name, avatar_url: n.actor.avatar_url });
      }
      existing.count++;
      if (new Date(n.created_at) > new Date(existing.latestAt)) existing.latestAt = n.created_at;
      if (n.read_at === null) existing.readAt = null;
    } else {
      groups.set(key, {
        type: n.type,
        postId: n.post_id,
        actors: [{ id: n.actor_id, name: n.actor.name, avatar_url: n.actor.avatar_url }],
        latestAt: n.created_at,
        count: 1,
        readAt: n.read_at,
      });
    }
  }
  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime(),
  );
}

// ── Wellbeing tracking (local-only screen-time counter) ──
export function getSessionMinutes(): number {
  const sessionStart = sessionStorage.getItem('forsure-session-start');
  if (!sessionStart) {
    sessionStorage.setItem('forsure-session-start', Date.now().toString());
    return 0;
  }
  return Math.floor((Date.now() - parseInt(sessionStart)) / 60000);
}

export function getTodayMinutes(): number {
  try {
    const data = JSON.parse(localStorage.getItem('forsure-daily-usage') || '{}');
    const today = new Date().toISOString().split('T')[0];
    return data[today] || 0;
  } catch { return 0; }
}

export function trackMinute() {
  try {
    const data = JSON.parse(localStorage.getItem('forsure-daily-usage') || '{}');
    const today = new Date().toISOString().split('T')[0];
    data[today] = (data[today] || 0) + 1;
    const keys = Object.keys(data).sort().slice(-7);
    const cleaned: Record<string, number> = {};
    keys.forEach(k => { cleaned[k] = data[k]; });
    localStorage.setItem('forsure-daily-usage', JSON.stringify(cleaned));
  } catch {
    // localStorage can be unavailable in privacy modes.
  }
}

export function getWeeklyUsage(): number[] {
  try {
    const data = JSON.parse(localStorage.getItem('forsure-daily-usage') || '{}');
    const result: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      result.push(data[key] || 0);
    }
    return result;
  } catch { return [0, 0, 0, 0, 0, 0, 0]; }
}
