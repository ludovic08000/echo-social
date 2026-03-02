import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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
    return {
      score: -new Date(post.created_at).getTime(),
      factors: { chronological: 1 },
    };
  }

  let score = 0;
  const isFriend = friendIds.has(post.user_id) || post.user_id === userId;

  // 1. Engagement (capped)
  const rawEngagement =
    (post.likes_count || 0) * 1.0 + (post.comments_count || 0) * 2.5;
  const engagementCap = config.viralContentReduce ? 20 : 40;
  const engagementScore = Math.min(engagementCap, rawEngagement * 2);
  factors.engagement = engagementScore;
  score += engagementScore;

  // 2. Social proximity
  const friendWeight = config.friendsWeight / 100;
  if (config.feedAlgorithm === "friends_first") {
    if (isFriend) {
      factors.friend_boost = 50;
      score += 50;
    }
  } else {
    const interactions = friendInteractions.get(post.user_id) || 0;
    const socialScore = Math.min(30, interactions * 5) * friendWeight;
    factors.social = socialScore;
    score += socialScore;
  }

  // 3. Discovery
  const discoveryWeight = config.discoveryWeight / 100;
  if (!isFriend) {
    factors.discovery = 10 * discoveryWeight;
    score += 10 * discoveryWeight;
  }

  // 4. Rich content
  if (post.image_url) {
    factors.media = 12;
    score += 12;
  }
  const textLen = (post.body || "").length;
  if (textLen > 50 && textLen < 500) {
    factors.text_quality = 6;
    score += 6;
  }

  // 5. Recency (12h half-life)
  const ageMs = Date.now() - new Date(post.created_at).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 25 * Math.exp(-ageHours / 12));
  factors.recency = recencyScore;
  score += recencyScore;

  // 6. Own posts
  if (post.user_id === userId) {
    factors.own = 3;
    score += 3;
  }

  // 7. Anti-spam
  const spamPenalty = getSpamScore(post.body || "") * 0.5;
  factors.spam_penalty = -spamPenalty;
  score -= spamPenalty;

  // 8. Diversity penalty
  const authorCount = seenAuthors.get(post.user_id) || 0;
  if (authorCount > 0) {
    const diversityPenalty =
      (config.diversityBoost / 100) * 12 * authorCount;
    factors.diversity_penalty = -diversityPenalty;
    score -= diversityPenalty;
  }

  // 9. Trust score boost (authors with high trust get a bump)
  const trustBoost = ((trustScore - 50) / 50) * 10; // -10 to +10
  factors.trust = trustBoost;
  score += trustBoost;

  // 10. Controlled randomization
  const rand = Math.random() * 6;
  factors.random = rand;
  score += rand;

  // 11. Muted keywords filter
  if (config.mutedKeywords.length > 0) {
    const lower = (post.body || "").toLowerCase();
    if (config.mutedKeywords.some((kw: string) => lower.includes(kw))) {
      factors.muted = -1000;
      score -= 1000;
    }
  }

  return { score, factors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get user from token
    const userClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const {
      data: { user },
    } = await userClient.auth.getUser();
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

    // Fetch posts (last 7 days)
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();
    const { data: posts } = await supabase
      .from("posts")
      .select("id, user_id, body, image_url, created_at")
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(200);

    if (!posts || posts.length === 0) {
      return new Response(JSON.stringify({ postIds: [], scores: {} }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch friend IDs
    const { data: friendships } = await supabase
      .from("friendships")
      .select("requester_id, addressee_id")
      .or(
        `requester_id.eq.${user.id},addressee_id.eq.${user.id}`
      )
      .eq("status", "accepted");

    const friendIds = new Set<string>();
    const friendInteractions = new Map<string, number>();
    (friendships || []).forEach((f: any) => {
      const fid =
        f.requester_id === user.id ? f.addressee_id : f.requester_id;
      friendIds.add(fid);
      friendInteractions.set(fid, 1);
    });

    // Fetch likes to boost interaction counts
    const { data: recentLikes } = await supabase
      .from("likes")
      .select("post_id")
      .eq("user_id", user.id)
      .limit(100);

    // Get like/comment counts per post
    const postIds = posts.map((p: any) => p.id);
    const { data: likeCounts } = await supabase
      .from("likes")
      .select("post_id")
      .in("post_id", postIds);

    const { data: commentCounts } = await supabase
      .from("comments")
      .select("post_id")
      .in("post_id", postIds);

    const likeMap = new Map<string, number>();
    (likeCounts || []).forEach((l: any) => {
      likeMap.set(l.post_id, (likeMap.get(l.post_id) || 0) + 1);
    });
    const commentMap = new Map<string, number>();
    (commentCounts || []).forEach((c: any) => {
      commentMap.set(c.post_id, (commentMap.get(c.post_id) || 0) + 1);
    });

    // Get trust scores for post authors
    const authorIds = [...new Set(posts.map((p: any) => p.user_id))];
    const { data: trustScores } = await supabase
      .from("trust_scores")
      .select("user_id, trust_score")
      .in("user_id", authorIds);

    const trustMap = new Map<string, number>();
    (trustScores || []).forEach((t: any) => {
      trustMap.set(t.user_id, t.trust_score);
    });

    // Score all posts
    const seenAuthors = new Map<string, number>();
    const scoredPosts = posts.map((post: any) => {
      const enrichedPost = {
        ...post,
        likes_count: likeMap.get(post.id) || 0,
        comments_count: commentMap.get(post.id) || 0,
      };

      const authorTrust = trustMap.get(post.user_id) || 50;
      const { score, factors } = scorePost(
        enrichedPost,
        friendIds,
        friendInteractions,
        user.id,
        config,
        seenAuthors,
        authorTrust
      );

      seenAuthors.set(
        post.user_id,
        (seenAuthors.get(post.user_id) || 0) + 1
      );

      return { postId: post.id, score, factors };
    });

    // Sort by score descending
    scoredPosts.sort((a: any, b: any) => b.score - a.score);

    // Paginate
    const paginated = scoredPosts.slice(offset, offset + limit);
    const postIdsResult = paginated.map((p: any) => p.postId);
    const scoresMap: Record<string, any> = {};
    paginated.forEach((p: any) => {
      scoresMap[p.postId] = { score: p.score, factors: p.factors };
    });

    return new Response(
      JSON.stringify({ postIds: postIdsResult, scores: scoresMap }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
