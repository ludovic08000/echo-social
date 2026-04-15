// ────────────────────────────────────────────────────────
// Feed Algorithm Engine v2
// Monte Carlo + Thompson Sampling + Social Graph Scoring
// Anti-spam, anti-bias, diversity quotas, cold-start boost
// DB-backed config via feed_algorithm_config table
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
  friendInteractionCounts: Map<string, number>; // friend_id → interaction score
  userId: string;
  prefs: ContentPrefs;
  weights: FeedWeights;
  seenAuthors: Set<string>;
  postIndex: number;
  userInterests?: string[];         // user's interest tags
  algoConfig?: Record<string, any>; // DB-backed config overrides
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
  /(.)\1{5,}/i,
  /https?:\/\/\S+/gi,
  /(buy|sell|discount|free|click|subscribe|follow me)/gi,
  /(\b\w+\b)(\s+\1){3,}/gi,
];

export function getSpamScore(text: string): number {
  let spam = 0;
  if (SPAM_PATTERNS[0].test(text)) spam += 30;
  const links = text.match(SPAM_PATTERNS[1]);
  if (links && links.length > 2) spam += 20 * links.length;
  const spamWords = text.match(SPAM_PATTERNS[2]);
  if (spamWords && spamWords.length > 3) spam += 15 * spamWords.length;
  if (SPAM_PATTERNS[3].test(text)) spam += 25;
  const capsRatio = (text.match(/[A-Z]/g)?.length || 0) / Math.max(1, text.length);
  if (capsRatio > 0.5 && text.length > 20) spam += 20;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 10) spam += 15;
  return Math.min(100, spam);
}

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
  const factor = (diversityBoost / 100) * 15;
  return count * factor;
}

// ── Continuous recency decay (half-life model) ──
// Half-life = 4 hours → score halves every 4h
// Much smoother than step function; recent posts get strong boost, old posts decay gracefully
function getRecencyScore(ageHours: number): number {
  const halfLife = 4; // hours
  const maxScore = 55;
  // Exponential decay: score = max * 0.5^(age/halfLife)
  return maxScore * Math.pow(0.5, ageHours / halfLife);
}

// ── Engagement velocity (trending detection) ──
// Uses Wilson score interval lower bound for statistical significance
function getEngagementVelocity(likes: number, comments: number, ageHours: number): number {
  if (ageHours < 0.05) return 0;
  const total = likes + comments * 2.5; // comments weighted more
  const velocity = total / Math.max(0.5, ageHours);
  
  // Wilson score: confidence-adjusted engagement rate
  const n = Math.max(1, Math.ceil(ageHours * 10)); // estimated impressions
  const p = Math.min(1, total / n);
  const z = 1.96; // 95% confidence
  const wilson = (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
  
  const velocityScore = Math.min(20, Math.log2(1 + velocity) * 5);
  const wilsonBonus = Math.max(0, wilson * 15);
  
  return velocityScore + wilsonBonus;
}

// ── Social proximity: multi-signal scoring ──
// Combines: friendship, mutual interactions (likes, comments, messages)
function getSocialProximityScore(
  authorId: string,
  ctx: ScoringContext
): number {
  const friendWeight = ctx.weights.friends / 100;
  const interactionScore = ctx.friendInteractionCounts.get(authorId) || 0;
  const isFriend = interactionScore > 0 || authorId === ctx.userId;

  if (ctx.prefs.feedAlgorithm === 'friends_first') {
    // In friends_first mode, massive boost for friends
    return isFriend ? 60 : -10;
  }

  let score = 0;

  // Base friendship bonus
  if (isFriend) score += 10;

  // Interaction-weighted proximity (logarithmic to avoid power users dominating)
  // interactionScore is a composite: likes_given*2 + comments_given*3 + messages*1
  if (interactionScore > 0) {
    score += Math.min(30, Math.log2(1 + interactionScore) * 8) * friendWeight;
  }

  return score;
}

// ── Content quality scoring ──
function getContentQualityScore(post: { body: string; image_url: string | null }): number {
  let score = 0;

  // Rich media bonus
  if (post.image_url) score += 12;

  // Optimal text length (sweet spot: 80-400 chars)
  const len = post.body.length;
  if (len >= 80 && len <= 400) score += 10;
  else if (len > 400 && len <= 800) score += 7;
  else if (len > 20 && len < 80) score += 4;
  else if (len <= 20) score += 1; // very short = low effort

  // Paragraph structure (line breaks = better formatting)
  const paragraphs = post.body.split(/\n\s*\n/).length;
  if (paragraphs >= 2 && paragraphs <= 5) score += 3;

  // Question mark = engagement driver
  if (post.body.includes('?')) score += 3;

  // Hashtag presence (topical)
  const hashtags = (post.body.match(/#\w+/g) || []).length;
  if (hashtags >= 1 && hashtags <= 5) score += 2;
  if (hashtags > 8) score -= 5; // hashtag spam

  return score;
}

// ── Interest affinity scoring ──
function getInterestAffinity(postBody: string, userInterests: string[]): number {
  if (!userInterests || userInterests.length === 0) return 0;
  const lower = postBody.toLowerCase();
  let matches = 0;
  for (const interest of userInterests) {
    if (lower.includes(interest.toLowerCase())) matches++;
  }
  // Diminishing returns: first match = 8pts, second = 5pts, etc.
  if (matches === 0) return 0;
  return Math.min(20, 8 + (matches - 1) * 3);
}

// ── Cold-start exploration boost ──
// New posts with very low engagement get a boost to ensure they're seen
function getColdStartBoost(likes: number, comments: number, ageHours: number): number {
  const totalEngagement = likes + comments;
  if (totalEngagement > 5 || ageHours > 12) return 0;
  // The less engagement + the newer = more boost
  const freshness = Math.max(0, 1 - ageHours / 12);
  const coldness = Math.max(0, 1 - totalEngagement / 5);
  return freshness * coldness * 12;
}

// ── Time-of-day activity multiplier ──
function getTimeOfDayMultiplier(postDate: Date): number {
  const hour = postDate.getHours();
  if ((hour >= 7 && hour <= 9) || (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 23)) return 1.3;
  if (hour >= 10 && hour <= 11) return 1.1;
  if (hour >= 15 && hour <= 17) return 1.0;
  return 0.7;
}

// ── Monte Carlo PRNG ──
let _mcSeed = (Date.now() ^ 0xDEADBEEF) >>> 0;
function mcRandom(): number {
  _mcSeed ^= _mcSeed << 13;
  _mcSeed ^= _mcSeed >> 17;
  _mcSeed ^= _mcSeed << 5;
  return (_mcSeed >>> 0) / 0xFFFFFFFF;
}

function sampleBeta(alpha: number, beta: number): number {
  function gammaVariate(shape: number): number {
    if (shape >= 1) {
      const d = shape - 1 / 3;
      const c = 1 / Math.sqrt(9 * d);
      while (true) {
        let x: number, v: number;
        do {
          x = gaussianRandom();
          v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = mcRandom();
        if (u < 1 - 0.0331 * x * x * x * x) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
      }
    }
    return gammaVariate(shape + 1) * Math.pow(mcRandom(), 1 / shape);
  }
  const ga = gammaVariate(alpha);
  const gb = gammaVariate(beta);
  return ga / (ga + gb);
}

let _hasSpare = false;
let _spare = 0;
function gaussianRandom(): number {
  if (_hasSpare) { _hasSpare = false; return _spare; }
  let u: number, v: number, s: number;
  do {
    u = mcRandom() * 2 - 1;
    v = mcRandom() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  s = Math.sqrt(-2 * Math.log(s) / s);
  _spare = v * s;
  _hasSpare = true;
  return u * s;
}

type ContentCategory = 'friend_text' | 'friend_media' | 'discovery_text' | 'discovery_media' | 'own';

function classifyPost(post: { user_id: string; image_url: string | null }, isFriend: boolean, isOwn: boolean): ContentCategory {
  if (isOwn) return 'own';
  const hasMedia = !!post.image_url;
  if (isFriend) return hasMedia ? 'friend_media' : 'friend_text';
  return hasMedia ? 'discovery_media' : 'discovery_text';
}

const CATEGORY_TARGETS: Record<ContentCategory, number> = {
  own: 0.05,
  friend_media: 0.30,
  friend_text: 0.25,
  discovery_media: 0.25,
  discovery_text: 0.15,
};

function getDiversityAdjustment(
  category: ContentCategory,
  categoryCounts: Map<ContentCategory, number>,
  totalPlaced: number,
  diversityBoost: number
): number {
  if (totalPlaced < 2) return 0;
  const actual = (categoryCounts.get(category) || 0) / totalPlaced;
  const target = CATEGORY_TARGETS[category];
  const deficit = target - actual;
  return deficit * (diversityBoost / 100) * 40;
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
  const { prefs } = ctx;

  if (prefs.feedAlgorithm === 'chronological') {
    return -new Date(post.created_at).getTime();
  }

  // Get DB config overrides
  const cfg = ctx.algoConfig || {};
  const recencyMultiplier = (cfg.recency_multiplier as number) || 1.0;
  const engagementMultiplier = (cfg.engagement_multiplier as number) || 1.0;
  const socialMultiplier = (cfg.social_multiplier as number) || 1.0;
  const qualityMultiplier = (cfg.quality_multiplier as number) || 1.0;

  let score = 0;
  const isOwn = post.user_id === ctx.userId;
  const postDate = new Date(post.created_at);
  const ageMs = Date.now() - postDate.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // ── 1. RECENCY (half-life decay) ──
  score += getRecencyScore(ageHours) * recencyMultiplier;

  // ── 2. ENGAGEMENT VELOCITY (Wilson score) ──
  score += getEngagementVelocity(post.likes_count, post.comments_count, ageHours) * engagementMultiplier;

  // ── 3. CAPPED ENGAGEMENT ──
  const rawEngagement = post.likes_count * 1.0 + post.comments_count * 2.5;
  const engagementCap = prefs.viralContentReduce ? 15 : 30;
  score += Math.min(engagementCap, rawEngagement * 1.5) * engagementMultiplier;

  // ── 4. SOCIAL PROXIMITY (multi-signal) ──
  score += getSocialProximityScore(post.user_id, ctx) * socialMultiplier;

  // ── 5. DISCOVERY BOOST ──
  const isFriend = ctx.friendInteractionCounts.has(post.user_id);
  const discoveryWeight = ctx.weights.discovery / 100;
  if (!isFriend && !isOwn) {
    const discoveryRecency = ageHours < 6 ? 15 : 8;
    score += discoveryRecency * discoveryWeight;
  }

  // ── 6. CONTENT QUALITY ──
  score += getContentQualityScore(post) * qualityMultiplier;

  // ── 7. INTEREST AFFINITY ──
  score += getInterestAffinity(post.body, ctx.userInterests || []);

  // ── 8. COLD-START BOOST ──
  score += getColdStartBoost(post.likes_count, post.comments_count, ageHours);

  // ── 9. TIME-OF-DAY ──
  score += (getTimeOfDayMultiplier(postDate) - 1) * 15;

  // ── 10. OWN POSTS (always visible at top when fresh) ──
  if (isOwn) {
    if (ageHours < 0.5) score += 500;
    else if (ageHours < 2) score += 100;
    else if (ageHours < 6) score += 30;
    else score += 5;
  }

  // ── 11. ANTI-SPAM ──
  score -= getSpamScore(post.body) * 0.6;

  // ── 12. DIVERSITY PENALTY (author repetition, exponential) ──
  const authorSeen = ctx.seenAuthors.has(post.user_id);
  if (authorSeen) {
    score -= (prefs.diversityBoost / 100) * 14;
  }

  return score;
}

// ── Monte Carlo Feed Ranker ──
export function monteCarloRank<T extends {
  id: string;
  user_id: string;
  body: string;
  image_url: string | null;
  created_at: string;
  likes_count: number;
  comments_count: number;
}>(
  posts: T[],
  ctx: ScoringContext,
  simulations: number = 50
): T[] {
  if (posts.length <= 1 || ctx.prefs.feedAlgorithm === 'chronological') return posts;

  const baseScores = new Map<string, number>();
  posts.forEach(p => baseScores.set(p.id, scorePost(p, ctx)));

  // Thompson Sampling with engagement + recency priors
  const thompsonParams = new Map<string, { alpha: number; beta: number }>();
  posts.forEach(p => {
    const engagement = p.likes_count + p.comments_count * 2;
    const ageHours = (Date.now() - new Date(p.created_at).getTime()) / 3_600_000;
    const exposure = Math.max(1, Math.ceil(ageHours * 8)); // better impressions estimate
    const alpha = 1 + engagement;
    const beta = 1 + Math.max(0, exposure - engagement);
    thompsonParams.set(p.id, { alpha, beta });
  });

  const totalScores = new Map<string, number>();
  posts.forEach(p => totalScores.set(p.id, 0));

  for (let sim = 0; sim < simulations; sim++) {
    const categoryCounts = new Map<ContentCategory, number>();
    let totalPlaced = 0;

    const simScores: { id: string; score: number }[] = posts.map(p => {
      const base = baseScores.get(p.id) || 0;
      const params = thompsonParams.get(p.id)!;

      const sampledEngagement = sampleBeta(params.alpha, params.beta);
      const explorationBonus = sampledEngagement * 25;
      const noise = gaussianRandom() * 3;

      return { id: p.id, score: base + explorationBonus + noise };
    });

    simScores.sort((a, b) => b.score - a.score);

    simScores.forEach((item, idx) => {
      const post = posts.find(p => p.id === item.id)!;
      const isFriend = ctx.friendInteractionCounts.has(post.user_id) || post.user_id === ctx.userId;
      const isOwn = post.user_id === ctx.userId;
      const category = classifyPost(post, isFriend, isOwn);

      const diversityAdj = getDiversityAdjustment(category, categoryCounts, totalPlaced, ctx.prefs.diversityBoost);
      const positionPenalty = idx * 0.5;
      const adjustedScore = item.score + diversityAdj - positionPenalty;

      totalScores.set(item.id, (totalScores.get(item.id) || 0) + adjustedScore);
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      totalPlaced++;
    });
  }

  const ranked = posts
    .map(p => ({ post: p, avgScore: (totalScores.get(p.id) || 0) / simulations }))
    .sort((a, b) => b.avgScore - a.avgScore);

  return ranked.map(r => r.post);
}

// ── Fair marketplace rotation ──
export function rotateMarketplaceProducts<T extends { seller_id: string; created_at: string; order_count: number; view_count: number }>(
  products: T[],
  pageIndex: number = 0
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
    (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime()
  );
}

// ── Wellbeing ──
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
  } catch { return [0, 0, 0, 0, 0, 0, 0]; }
}

// ── DB-backed algorithm config (Zeus can modify these) ──
let _cachedAlgoConfig: Record<string, any> | null = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

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
