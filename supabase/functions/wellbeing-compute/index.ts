import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rate-limit.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing auth");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const rateLimited = await checkRateLimit(`wellbeing-compute:${user.id}`, 10, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const uid = user.id;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();

    // ── 1. Screen time proxy: post/comment activity volume ──
    const { count: postCount } = await supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .gte("created_at", weekAgo);

    // Ideal: 3-10 posts/week → score high; 0 or 30+ → lower
    const pc = postCount ?? 0;
    const screenTimeScore =
      pc === 0 ? 30 : pc <= 10 ? 70 + Math.min(pc * 3, 30) : Math.max(20, 100 - pc * 2);

    // ── 2. Social balance: ratio of friends interacted with vs total ──
    const { count: friendCount } = await supabase
      .from("friendships")
      .select("id", { count: "exact", head: true })
      .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`)
      .eq("status", "accepted");

    const { data: recentConvos } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("sender_id", uid)
      .gte("created_at", weekAgo)
      .limit(100);

    const uniqueConvos = new Set((recentConvos ?? []).map((m) => m.conversation_id)).size;
    const fc = friendCount ?? 1;
    const socialRatio = Math.min(uniqueConvos / Math.max(fc, 1), 1);
    const socialBalanceScore = Math.round(40 + socialRatio * 60);

    // ── 3. Content diversity: distinct reaction types used ──
    const { data: reactions } = await supabase
      .from("likes")
      .select("reaction_type")
      .eq("user_id", uid)
      .gte("created_at", weekAgo)
      .limit(200);

    const reactionTypes = new Set((reactions ?? []).map((r) => r.reaction_type));
    const diversityScore = Math.min(30 + reactionTypes.size * 15, 100);

    // ── 4. Break frequency: gaps between posts (healthy = spread out) ──
    const { data: recentPosts } = await supabase
      .from("posts")
      .select("created_at")
      .eq("user_id", uid)
      .gte("created_at", weekAgo)
      .order("created_at", { ascending: true })
      .limit(50);

    let breakScore = 60;
    if (recentPosts && recentPosts.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < recentPosts.length; i++) {
        gaps.push(
          new Date(recentPosts[i].created_at).getTime() -
            new Date(recentPosts[i - 1].created_at).getTime()
        );
      }
      const avgGapHours = gaps.reduce((a, b) => a + b, 0) / gaps.length / 3600000;
      // Ideal gap: 4-24h → high score
      breakScore =
        avgGapHours < 0.5
          ? 20
          : avgGapHours < 4
          ? 50
          : avgGapHours <= 24
          ? 90
          : 70;
    }

    // ── 5. Positivity: ratio of positive reactions received ──
    const { data: myPostIds } = await supabase
      .from("posts")
      .select("id")
      .eq("user_id", uid)
      .gte("created_at", weekAgo)
      .limit(50);

    let positivityScore = 60;
    if (myPostIds && myPostIds.length > 0) {
      const ids = myPostIds.map((p) => p.id);
      const { data: receivedLikes } = await supabase
        .from("likes")
        .select("reaction_type")
        .in("post_id", ids)
        .limit(500);

      const positiveTypes = new Set(["like", "love", "haha", "wow", "fire"]);
      const total = receivedLikes?.length ?? 0;
      const positive = (receivedLikes ?? []).filter((l) =>
        positiveTypes.has(l.reaction_type)
      ).length;
      positivityScore =
        total === 0 ? 50 : Math.round(30 + (positive / total) * 70);
    }

    // ── Composite score (weighted average) ──
    const composite = Math.round(
      screenTimeScore * 0.25 +
        socialBalanceScore * 0.2 +
        diversityScore * 0.15 +
        breakScore * 0.2 +
        positivityScore * 0.2
    );

    const factors = {
      posts_this_week: pc,
      friends: fc,
      conversations_active: uniqueConvos,
      reaction_types_used: reactionTypes.size,
      avg_gap_hours:
        recentPosts && recentPosts.length >= 2
          ? Math.round(
              (recentPosts
                .slice(1)
                .reduce(
                  (s, p, i) =>
                    s +
                    (new Date(p.created_at).getTime() -
                      new Date(recentPosts![i].created_at).getTime()),
                  0
                ) /
                (recentPosts.length - 1) /
                3600000) * 10
            ) / 10
          : null,
    };

    // Upsert
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    await admin.from("wellbeing_scores").upsert(
      {
        user_id: uid,
        score: composite,
        screen_time_score: screenTimeScore,
        social_balance_score: socialBalanceScore,
        content_diversity_score: diversityScore,
        break_frequency_score: breakScore,
        positivity_score: positivityScore,
        factors,
        computed_at: now.toISOString(),
      },
      { onConflict: "user_id" }
    );

    return new Response(
      JSON.stringify({ score: composite, screen_time_score: screenTimeScore, social_balance_score: socialBalanceScore, content_diversity_score: diversityScore, break_frequency_score: breakScore, positivity_score: positivityScore, factors }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
