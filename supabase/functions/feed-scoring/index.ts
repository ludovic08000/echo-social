import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit, getClientIP } from "../_shared/rate-limit.ts";
import { cached } from "../_shared/edge-cache.ts";

interface ScoringConfig {
  feedAlgorithm: "smart" | "chronological" | "friends_first";
  diversityBoost: number;
  mutedKeywords: string[];
  viralContentReduce: boolean;
  friendsWeight: number;
  discoveryWeight: number;
}

const SPAM_PATTERNS = [
  /(.)\1{5,}/i,
  /(buy|sell|discount|free|click|subscribe|follow me)/gi,
  /(\b\w+\b)(\s+\1){3,}/gi,
];

function getSpamScore(text: string): number {
  let spam = 0;
  if (SPAM_PATTERNS[0].test(text)) spam += 30;
  const spamWords = text.match(SPAM_PATTERNS[1]);
  if (spamWords && spamWords.length > 3) spam += 15 * spamWords.length;
  if (SPAM_PATTERNS[2].test(text)) spam += 25;
  const capsRatio =
    (text.match(/[A-Z]/g)?.length || 0) / Math.max(1, text.length);
  if (capsRatio > 0.5 && text.length > 20) spam += 20;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 10) spam += 15;
  return Math.min(100, spam);
}

function getTimeOfDayMultiplier(postDate: Date): number {
  const hour = postDate.getHours();
  if ((hour >= 7 && hour <= 9) || (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 23)) return 1.3;
  if (hour >= 10 && hour <= 11) return 1.1;
  if (hour >= 15 && hour <= 17) return 1.0;
  return 0.7;
}

function getEngagementVelocity(likes: number, comments: number, ageHours: number): number {
  if (ageHours < 0.1) return 0;
  const totalEngagement = likes + comments * 2;
  const velocity = totalEngagement / Math.max(0.5, ageHours);
  return Math.min(20, Math.log2(1 + velocity) * 5);
}

function getRecencyScore(ageHours: number): number {
  if (ageHours < 1) return 50;
  if (ageHours < 3) return 40;
  if (ageHours < 6) return 30;
  if (ageHours < 12) return 18;
  if (ageHours < 24) return 10;
  if (ageHours < 48) return 5;
  return Math.max(0, 3 * Math.exp(-(ageHours - 48) / 72));
}

function scorePost(
  post: any,
  friendIds: Set<string>,
  friendInteractions: Map<string, number>,
  userId: string,
  config: ScoringConfig,
  seenAuthors: Map<string, number>,
  trustScore: number
): { score: number; factors: Record<string, number> } {
  const factors: Record<string, number> = {};

  if (config.feedAlgorithm === "chronological") {
    return { score: -new Date(post.created_at).getTime(), factors: { chronological: 1 } };
  }

  let score = 0;
  const isFriend = friendIds.has(post.user_id) || post.user_id === userId;
  const postDate = new Date(post.created_at);
  const ageHours = (Date.now() - postDate.getTime()) / (1000 * 60 * 60);

  const recencyScore = getRecencyScore(ageHours);
  factors.recency = recencyScore;
  score += recencyScore;

  const velocity = getEngagementVelocity(post.likes_count || 0, post.comments_count || 0, ageHours);
  factors.velocity = velocity;
  score += velocity;

  const rawEngagement = (post.likes_count || 0) * 1.0 + (post.comments_count || 0) * 2.5;
  const engagementCap = config.viralContentReduce ? 15 : 30;
  const engagementScore = Math.min(engagementCap, rawEngagement * 1.5);
  factors.engagement = engagementScore;
  score += engagementScore;

  const friendWeight = config.friendsWeight / 100;
  if (config.feedAlgorithm === "friends_first") {
    if (isFriend) { factors.friend_boost = 45; score += 45; }
  } else {
    const interactions = friendInteractions.get(post.user_id) || 0;
    const socialScore = Math.min(25, interactions * 4) * friendWeight;
    if (isFriend) { factors.friend_base = 8; score += 8; }
    factors.social = socialScore;
    score += socialScore;
  }

  const discoveryWeight = config.discoveryWeight / 100;
  if (!isFriend) {
    const discoveryRecency = ageHours < 6 ? 15 : 8;
    factors.discovery = discoveryRecency * discoveryWeight;
    score += discoveryRecency * discoveryWeight;
  }

  if (post.image_url) { factors.media = 14; score += 14; }
  const textLen = (post.body || "").length;
  if (textLen > 80 && textLen < 600) { factors.text_quality = 8; score += 8; }
  else if (textLen > 20 && textLen <= 80) { factors.text_quality = 4; score += 4; }

  const todBoost = (getTimeOfDayMultiplier(postDate) - 1) * 15;
  factors.time_of_day = todBoost;
  score += todBoost;

  if (post.user_id === userId) { factors.own = 5; score += 5; }

  const spamPenalty = getSpamScore(post.body || "") * 0.6;
  factors.spam_penalty = -spamPenalty;
  score -= spamPenalty;

  const authorCount = seenAuthors.get(post.user_id) || 0;
  if (authorCount > 0) {
    const diversityPenalty = (config.diversityBoost / 100) * (8 + 6 * authorCount);
    factors.diversity_penalty = -diversityPenalty;
    score -= diversityPenalty;
  }

  const trustBoost = ((trustScore - 50) / 50) * 8;
  factors.trust = trustBoost;
  score += trustBoost;

  const randRange = ageHours < 6 ? 10 : 5;
  const rand = Math.random() * randRange;
  factors.random = rand;
  score += rand;

  if (config.mutedKeywords.length > 0) {
    const lower = (post.body || "").toLowerCase();
    if (config.mutedKeywords.some((kw: string) => lower.includes(kw))) {
      factors.muted = -1000;
      score -= 1000;
    }
  }

  return { score, factors };
}

// ─── Reusable service-role client (persists across warm invocations) ───
let _supabase: ReturnType<typeof createClient> | null = null;
function getServiceClient() {
  if (!_supabase) {
    _supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
  }
  return _supabase;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ip = getClientIP(req);
    const rateLimited = await checkRateLimit(`feed-scoring:${ip}`, 30, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = getServiceClient();

    // Auth — lightweight getClaims instead of getUser (no DB round-trip)
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const config: ScoringConfig = {
      feedAlgorithm: body.feedAlgorithm || "smart",
      diversityBoost: body.diversityBoost ?? 50,
      mutedKeywords: body.mutedKeywords || [],
      viralContentReduce: body.viralContentReduce || false,
      friendsWeight: body.friendsWeight ?? 60,
      discoveryWeight: body.discoveryWeight ?? 30,
    };
    const limit = body.limit || 50;
    const offset = body.offset || 0;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // ── PARALLEL DB QUERIES (was sequential — 6 queries → now 3 parallel groups) ──
    const [postsResult, friendshipsData, trustScoresData] = await Promise.all([
      // 1. Posts with denormalized counts (no need for separate likes/comments queries)
      supabase
        .from("posts")
        .select("id, user_id, body, image_url, created_at, likes_count, comments_count")
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false })
        .limit(200),

      // 2. Friendships — cached 2 minutes per user (stable data)
      cached(`friends:${user.id}`, 120_000, async () => {
        const { data } = await supabase
          .from("friendships")
          .select("requester_id, addressee_id")
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
          .eq("status", "accepted");
        return data || [];
      }),

      // 3. Trust scores — cached 5 minutes (rarely changes)
      cached("trust_scores:all", 300_000, async () => {
        const { data } = await supabase
          .from("trust_scores")
          .select("user_id, trust_score");
        return data || [];
      }),
    ]);

    const posts = postsResult.data;
    if (!posts || posts.length === 0) {
      return new Response(JSON.stringify({ postIds: [], scores: {} }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build friend maps
    const friendIds = new Set<string>();
    const friendInteractions = new Map<string, number>();
    friendshipsData.forEach((f: any) => {
      const fid = f.requester_id === user.id ? f.addressee_id : f.requester_id;
      friendIds.add(fid);
      friendInteractions.set(fid, 1);
    });

    // Build trust map
    const trustMap = new Map<string, number>();
    trustScoresData.forEach((t: any) => {
      trustMap.set(t.user_id, t.trust_score);
    });

    // Score all posts (uses denormalized likes_count/comments_count — no extra queries)
    const seenAuthors = new Map<string, number>();
    const scoredPosts = posts.map((post: any) => {
      const authorTrust = trustMap.get(post.user_id) || 50;
      const { score, factors } = scorePost(
        post, friendIds, friendInteractions, user.id, config, seenAuthors, authorTrust
      );
      seenAuthors.set(post.user_id, (seenAuthors.get(post.user_id) || 0) + 1);
      return { postId: post.id, score, factors };
    });

    scoredPosts.sort((a: any, b: any) => b.score - a.score);

    const paginated = scoredPosts.slice(offset, offset + limit);
    const postIdsResult = paginated.map((p: any) => p.postId);
    const scoresMap: Record<string, any> = {};
    paginated.forEach((p: any) => {
      scoresMap[p.postId] = { score: p.score, factors: p.factors };
    });

    return new Response(
      JSON.stringify({ postIds: postIdsResult, scores: scoresMap }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
