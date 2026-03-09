// ────────────────────────────────────────────────────────
// Feed Algorithm Engine
// Anti-spam, anti-bias, configurable scoring, diversity
// Supports live DB-backed config via feed_algorithm_config table
// ────────────────────────────────────────────────────────

import { supabase } from '@/integrations/supabase/client';

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
  friends: number;    // 0-100
  discovery: number;  // 0-100
  marketplace: number; // 0-100
}

export interface ScoringContext {
  friendInteractionCounts: Map<string, number>;
  userId: string;
  prefs: ContentPrefs;
  weights: FeedWeights;
  seenAuthors: Set<string>; // for diversity tracking
  postIndex: number; // position in feed for decay
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

// ── Anti-spam detection ──
const SPAM_PATTERNS = [
  /(.)\1{5,}/i,                    // character repetition: aaaaaa
  /https?:\/\/\S+/gi,              // excessive links (counted)
  /(buy|sell|discount|free|click|subscribe|follow me)/gi, // spammy keywords
  /(\b\w+\b)(\s+\1){3,}/gi,       // word repetition
];

export function getSpamScore(text: string): number {
  let spam = 0;
  
  // Character repetition
  if (SPAM_PATTERNS[0].test(text)) spam += 30;
  
  // Link density
  const links = text.match(SPAM_PATTERNS[1]);
  if (links && links.length > 2) spam += 20 * links.length;
  
  // Spammy keywords density
  const spamWords = text.match(SPAM_PATTERNS[2]);
  if (spamWords && spamWords.length > 3) spam += 15 * spamWords.length;
  
  // Word repetition
  if (SPAM_PATTERNS[3].test(text)) spam += 25;
  
  // ALL CAPS ratio
  const capsRatio = (text.match(/[A-Z]/g)?.length || 0) / Math.max(1, text.length);
  if (capsRatio > 0.5 && text.length > 20) spam += 20;
  
  // Excessive emojis
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 10) spam += 15;
  
  return Math.min(100, spam);
}

// ── Muted keyword filter ──
export function containsMutedKeyword(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

// ── Anti-bias: author diversity enforcement ──
export function getDiversityPenalty(
  authorId: string,
  seenAuthors: Map<string, number>,
  diversityBoost: number
): number {
  const count = seenAuthors.get(authorId) || 0;
  // Higher diversity boost = stronger penalty for repeated authors
  const factor = (diversityBoost / 100) * 15;
  return count * factor;
}

// ── Time-of-day activity multiplier ──
function getTimeOfDayMultiplier(postDate: Date): number {
  const hour = postDate.getHours();
  if ((hour >= 7 && hour <= 9) || (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 23)) return 1.3;
  if (hour >= 10 && hour <= 11) return 1.1;
  if (hour >= 15 && hour <= 17) return 1.0;
  return 0.7;
}

// ── Engagement velocity (trending detection) ──
function getEngagementVelocity(likes: number, comments: number, ageHours: number): number {
  if (ageHours < 0.1) return 0;
  const total = likes + comments * 2;
  const velocity = total / Math.max(0.5, ageHours);
  return Math.min(20, Math.log2(1 + velocity) * 5);
}

// ── Tiered recency for dynamic feed ──
function getRecencyScore(ageHours: number): number {
  if (ageHours < 1) return 50;
  if (ageHours < 3) return 40;
  if (ageHours < 6) return 30;
  if (ageHours < 12) return 18;
  if (ageHours < 24) return 10;
  if (ageHours < 48) return 5;
  return Math.max(0, 3 * Math.exp(-(ageHours - 48) / 72));
}

// ── Main scoring function ──
export function scorePost(
  post: {
    id: string;
    user_id: string;
    body: string;
    image_url: string | null;
    created_at: string;
    likes_count: number;
    comments_count: number;
  },
  ctx: ScoringContext
): number {
  const { prefs, weights } = ctx;
  
  if (prefs.feedAlgorithm === 'chronological') {
    return -new Date(post.created_at).getTime();
  }

  let score = 0;
  const isFriend = ctx.friendInteractionCounts.has(post.user_id) || post.user_id === ctx.userId;
  const postDate = new Date(post.created_at);
  const ageMs = Date.now() - postDate.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // ── 1. RECENCY (tiered for dynamism) ──
  score += getRecencyScore(ageHours);

  // ── 2. ENGAGEMENT VELOCITY (trending) ──
  score += getEngagementVelocity(post.likes_count, post.comments_count, ageHours);

  // ── 3. ENGAGEMENT (capped) ──
  const rawEngagement = post.likes_count * 1.0 + post.comments_count * 2.5;
  const engagementCap = prefs.viralContentReduce ? 15 : 30;
  score += Math.min(engagementCap, rawEngagement * 1.5);

  // ── 4. SOCIAL PROXIMITY ──
  const friendWeight = weights.friends / 100;
  if (prefs.feedAlgorithm === 'friends_first') {
    if (isFriend) score += 45;
  } else {
    const interactionCount = ctx.friendInteractionCounts.get(post.user_id) || 0;
    score += Math.min(25, interactionCount * 4) * friendWeight;
    if (isFriend) score += 8; // Base friend boost
  }

  // ── 5. DISCOVERY BOOST ──
  const discoveryWeight = weights.discovery / 100;
  if (!isFriend) {
    const discoveryRecency = ageHours < 6 ? 15 : 8;
    score += discoveryRecency * discoveryWeight;
  }

  // ── 6. RICH CONTENT ──
  if (post.image_url) score += 14;
  const textLen = post.body.length;
  if (textLen > 80 && textLen < 600) score += 8;
  else if (textLen > 20 && textLen <= 80) score += 4;

  // ── 7. TIME-OF-DAY BOOST ──
  score += (getTimeOfDayMultiplier(postDate) - 1) * 15;

  // ── 8. OWN POSTS ──
  if (post.user_id === ctx.userId) score += 5;

  // ── 9. ANTI-SPAM ──
  score -= getSpamScore(post.body) * 0.6;

  // ── 10. DIVERSITY PENALTY (progressive) ──
  const authorAppearances = ctx.seenAuthors.has(post.user_id) ? 1 : 0;
  if (authorAppearances > 0) {
    score -= (prefs.diversityBoost / 100) * (8 + 6 * authorAppearances);
  }

  // ── 11. CONTROLLED RANDOMIZATION ──
  // Disabled for feed stability on mobile (prevents reorder-induced scroll jumps)
  // score += Math.random() * (ageHours < 6 ? 10 : 5);

  return score;
}

// ── Fair marketplace rotation ──
// Ensures equitable seller exposure, not always the same sellers on top
export function rotateMarketplaceProducts<T extends { seller_id: string; created_at: string; order_count: number; view_count: number }>(
  products: T[],
  pageIndex: number = 0
): T[] {
  if (products.length === 0) return [];

  // Group by seller
  const sellerGroups = new Map<string, T[]>();
  products.forEach(p => {
    const group = sellerGroups.get(p.seller_id) || [];
    group.push(p);
    sellerGroups.set(p.seller_id, group);
  });

  // Round-robin across sellers with a rotating offset based on time + page
  const sellers = Array.from(sellerGroups.keys());
  const hourOfDay = new Date().getHours();
  const offset = (hourOfDay + pageIndex) % Math.max(1, sellers.length);
  
  // Rotate seller order
  const rotatedSellers = [...sellers.slice(offset), ...sellers.slice(0, offset)];

  // Interleave: take one product from each seller in rotation
  const result: T[] = [];
  let maxDepth = 0;
  rotatedSellers.forEach(s => {
    const group = sellerGroups.get(s)!;
    maxDepth = Math.max(maxDepth, group.length);
  });

  for (let depth = 0; depth < maxDepth; depth++) {
    for (const seller of rotatedSellers) {
      const group = sellerGroups.get(seller)!;
      if (depth < group.length) {
        result.push(group[depth]);
      }
    }
  }

  return result;
}

// ── Smart notification grouping ──
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
  }>
): GroupedNotification[] {
  const groups = new Map<string, GroupedNotification>();

  for (const n of notifications) {
    // Group by type + post_id (e.g., "3 people liked your post")
    const key = `${n.type}:${n.post_id || 'none'}`;
    
    const existing = groups.get(key);
    if (existing) {
      // Only add unique actors
      if (!existing.actors.find(a => a.id === n.actor_id)) {
        existing.actors.push({ id: n.actor_id, name: n.actor.name, avatar_url: n.actor.avatar_url });
      }
      existing.count++;
      if (new Date(n.created_at) > new Date(existing.latestAt)) {
        existing.latestAt = n.created_at;
      }
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

  // Sort by most recent
  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime()
  );
}

// ── Wellbeing: scroll pause tracker ──
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
  } catch {
    return 0;
  }
}

export function trackMinute() {
  try {
    const data = JSON.parse(localStorage.getItem('forsure-daily-usage') || '{}');
    const today = new Date().toISOString().split('T')[0];
    data[today] = (data[today] || 0) + 1;
    // Keep only last 7 days
    const keys = Object.keys(data).sort().slice(-7);
    const cleaned: Record<string, number> = {};
    keys.forEach(k => { cleaned[k] = data[k]; });
    localStorage.setItem('forsure-daily-usage', JSON.stringify(cleaned));
  } catch {}
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
  } catch {
    return [0, 0, 0, 0, 0, 0, 0];
  }
}

// ── DB-backed algorithm config (Zeus can modify these) ──
let _cachedAlgoConfig: Record<string, any> | null = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

export async function loadAlgorithmConfig(): Promise<Record<string, any>> {
  if (_cachedAlgoConfig && Date.now() - _cacheTime < CACHE_TTL) {
    return _cachedAlgoConfig;
  }
  try {
    const { data } = await supabase
      .from('feed_algorithm_config')
      .select('key, value');
    if (data) {
      const config: Record<string, any> = {};
      data.forEach((row: any) => { config[row.key] = row.value; });
      _cachedAlgoConfig = config;
      _cacheTime = Date.now();
      return config;
    }
  } catch {}
  return {};
}

export function invalidateAlgoConfigCache() {
  _cachedAlgoConfig = null;
  _cacheTime = 0;
}
