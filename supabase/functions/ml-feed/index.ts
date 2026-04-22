import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit, getClientIP } from "../_shared/rate-limit.ts";

/**
 * ML Feed Engine — Lovable AI–powered personalization
 * 
 * Actions:
 *   score    → AI re-ranks posts based on user behavior profile
 *   recommend → AI suggests discovery posts the user hasn't seen
 *   track    → Record a behavior signal (view, dwell, like, etc.)
 */

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

interface UserProfile {
  topInterests: string[];
  preferredContentTypes: string[];
  activeHours: number[];
  avgDwellMs: number;
  engagementRate: number;
  friendBias: number;
}

async function buildUserProfile(supabase: any, userId: string): Promise<UserProfile> {
  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();

  const [signalsRes, interestsRes, likesRes] = await Promise.all([
    supabase
      .from("user_behavior_signals")
      .select("signal_type, value, metadata, created_at")
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("user_interests")
      .select("interest_value")
      .eq("user_id", userId)
      .limit(20),
    supabase
      .from("likes")
      .select("post_id, reaction_type, created_at")
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const signals = signalsRes.data || [];
  const interests = (interestsRes.data || []).map((i: any) => i.interest_value);
  const likes = likesRes.data || [];

  // Compute dwell time stats
  const dwellSignals = signals.filter((s: any) => s.signal_type === "dwell");
  const avgDwellMs = dwellSignals.length > 0
    ? dwellSignals.reduce((sum: number, s: any) => sum + Number(s.value), 0) / dwellSignals.length
    : 3000;

  // Compute engagement rate
  const viewSignals = signals.filter((s: any) => s.signal_type === "view");
  const interactionSignals = signals.filter((s: any) =>
    ["like", "comment", "share", "click_profile"].includes(s.signal_type)
  );
  const engagementRate = viewSignals.length > 0
    ? interactionSignals.length / viewSignals.length
    : 0.1;

  // Detect preferred content types from high-dwell posts
  const mediaPrefs: Record<string, number> = { text: 0, image: 0, video: 0 };
  for (const s of dwellSignals) {
    const type = s.metadata?.content_type || "text";
    mediaPrefs[type] = (mediaPrefs[type] || 0) + Number(s.value);
  }
  const preferredContentTypes = Object.entries(mediaPrefs)
    .sort((a, b) => b[1] - a[1])
    .map(([type]) => type);

  // Active hours from signal timestamps
  const hourCounts = new Array(24).fill(0);
  for (const s of signals) {
    const hour = new Date(s.created_at).getHours();
    hourCounts[hour]++;
  }
  const activeHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map(h => h.hour);

  // Friend bias: ratio of friend interactions vs discovery
  const friendInteractions = signals.filter((s: any) => s.metadata?.is_friend === true).length;
  const friendBias = signals.length > 0 ? friendInteractions / signals.length : 0.5;

  return {
    topInterests: interests,
    preferredContentTypes,
    activeHours,
    avgDwellMs,
    engagementRate,
    friendBias,
  };
}

/**
 * Strip PII (emails, URLs, @mentions, phone numbers) and aggressively truncate
 * post text before forwarding to the AI gateway. Returns "" if user opted out.
 */
function sanitizeForAI(text: string | null | undefined, allowed: boolean): string {
  if (!allowed || !text) return "";
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/@[\w.-]+/g, "[user]")
    .replace(/\+?\d[\d\s().-]{7,}/g, "[phone]")
    .slice(0, 40)
    .trim();
}

async function aiScorePosts(
  profile: UserProfile,
  posts: any[],
  userId: string,
  aiPersonalizationAllowed: boolean
): Promise<Record<string, number>> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY || posts.length === 0) return {};

  // Prepare compact post summaries for AI — body_preview is sanitized + truncated
  const postSummaries = posts.slice(0, 40).map((p: any) => ({
    id: p.id,
    age_h: Math.round((Date.now() - new Date(p.created_at).getTime()) / 3600000),
    likes: p.likes_count || 0,
    comments: p.comments_count || 0,
    has_media: !!p.image_url,
    body_len: (p.body || "").length,
    body_preview: sanitizeForAI(p.body, aiPersonalizationAllowed),
    is_friend: p._is_friend || false,
  }));

  const systemPrompt = `Tu es un moteur de recommandation ML pour un réseau social. Ton rôle est de scorer la pertinence de chaque post pour un utilisateur donné.

PROFIL UTILISATEUR :
- Centres d'intérêt : ${profile.topInterests.join(", ") || "non définis"}
- Types de contenu préférés : ${profile.preferredContentTypes.join(", ")}
- Taux d'engagement : ${(profile.engagementRate * 100).toFixed(1)}%
- Temps de lecture moyen : ${Math.round(profile.avgDwellMs / 1000)}s
- Biais amis/découverte : ${(profile.friendBias * 100).toFixed(0)}% amis
- Heures actives : ${profile.activeHours.join("h, ")}h

RÈGLES DE SCORING :
1. Score de 0 à 100 pour chaque post
2. Priorise la pertinence thématique (match intérêts)
3. Booste le contenu frais (<6h) avec bon engagement
4. Respecte le ratio amis/découverte de l'utilisateur
5. Pénalise le contenu spam ou très court sans valeur
6. Booste les contenus média si l'utilisateur préfère les images/vidéos`;

  const userPrompt = `Score ces posts pour cet utilisateur. Retourne UNIQUEMENT un appel à la fonction score_posts.

Posts : ${JSON.stringify(postSummaries)}`;

  try {
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [{
          type: "function",
          function: {
            name: "score_posts",
            description: "Retourne les scores ML pour chaque post",
            parameters: {
              type: "object",
              properties: {
                scores: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      post_id: { type: "string" },
                      score: { type: "number", description: "Score de 0 à 100" },
                      reason: { type: "string", description: "Raison courte du score" },
                    },
                    required: ["post_id", "score"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["scores"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "score_posts" } },
      }),
    });

    if (!response.ok) {
      console.error("AI gateway error:", response.status);
      return {};
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) return {};

    const parsed = JSON.parse(toolCall.function.arguments);
    const scoreMap: Record<string, number> = {};
    for (const s of parsed.scores || []) {
      scoreMap[s.post_id] = Math.max(0, Math.min(100, s.score));
    }
    return scoreMap;
  } catch (err) {
    console.error("AI scoring failed:", err);
    return {};
  }
}

async function aiRecommend(
  profile: UserProfile,
  candidatePosts: any[],
  seenPostIds: Set<string>,
  aiPersonalizationAllowed: boolean
): Promise<string[]> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY || candidatePosts.length === 0) return [];

  // Filter out already seen
  const unseen = candidatePosts.filter(p => !seenPostIds.has(p.id)).slice(0, 30);
  if (unseen.length === 0) return [];

  const summaries = unseen.map((p: any) => ({
    id: p.id,
    body_preview: sanitizeForAI(p.body, aiPersonalizationAllowed),
    likes: p.likes_count || 0,
    comments: p.comments_count || 0,
    has_media: !!p.image_url,
    age_h: Math.round((Date.now() - new Date(p.created_at).getTime()) / 3600000),
  }));

  try {
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content: `Tu es un moteur de recommandation. Sélectionne les 5-8 meilleurs posts de découverte pour cet utilisateur.
Intérêts : ${profile.topInterests.join(", ") || "variés"}
Contenu préféré : ${profile.preferredContentTypes.join(", ")}
Engagement moyen : ${(profile.engagementRate * 100).toFixed(0)}%`,
          },
          {
            role: "user",
            content: `Sélectionne les meilleurs posts de découverte parmi : ${JSON.stringify(summaries)}`,
          },
        ],
        tools: [{
          type: "function",
          function: {
            name: "recommend_posts",
            description: "Retourne les IDs des posts recommandés",
            parameters: {
              type: "object",
              properties: {
                post_ids: {
                  type: "array",
                  items: { type: "string" },
                  description: "IDs des posts recommandés, ordonnés par pertinence",
                },
              },
              required: ["post_ids"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "recommend_posts" } },
      }),
    });

    if (!response.ok) return [];

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) return [];

    const parsed = JSON.parse(toolCall.function.arguments);
    return (parsed.post_ids || []).filter((id: string) => unseen.some(p => p.id === id));
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ip = getClientIP(req);
    const rateLimited = await checkRateLimit(`ml-feed:${ip}`, 20, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = getServiceClient();
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
    const action = body.action;

    // Privacy-aware: check if user opted out of AI personalization (post body forwarding)
    const { data: privacyRow } = await supabase
      .from("privacy_settings")
      .select("ai_personalization_enabled")
      .eq("user_id", user.id)
      .maybeSingle();
    const aiPersonalizationAllowed = (privacyRow as any)?.ai_personalization_enabled !== false;

    // ══════════════════════════════
    // TRACK — Record behavior signal
    // ══════════════════════════════
    if (action === "track") {
      const { post_id, signal_type, value, metadata } = body;
      if (!post_id || !signal_type) {
        return new Response(JSON.stringify({ error: "post_id and signal_type required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const validSignals = ["view", "dwell", "scroll_past", "like", "comment", "share", "click_profile", "save"];
      if (!validSignals.includes(signal_type)) {
        return new Response(JSON.stringify({ error: "Invalid signal_type" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase.from("user_behavior_signals").insert({
        user_id: user.id,
        post_id,
        signal_type,
        value: value ?? 1,
        metadata: metadata ?? {},
      });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ══════════════════════════════════════════
    // SCORE — AI-powered post re-ranking
    // ══════════════════════════════════════════
    if (action === "score") {
      const postIds: string[] = body.post_ids || [];
      if (postIds.length === 0) {
        return new Response(JSON.stringify({ scores: {} }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Build user behavior profile
      const profile = await buildUserProfile(supabase, user.id);

      // Fetch posts data
      const { data: posts } = await supabase
        .from("posts")
        .select("id, user_id, body, image_url, created_at, likes_count, comments_count")
        .in("id", postIds.slice(0, 50));

      if (!posts || posts.length === 0) {
        return new Response(JSON.stringify({ scores: {} }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get friendships to mark friend posts
      const { data: friendships } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
        .eq("status", "accepted");

      const friendIds = new Set<string>();
      (friendships || []).forEach((f: any) => {
        friendIds.add(f.requester_id === user.id ? f.addressee_id : f.requester_id);
      });

      const enrichedPosts = posts.map((p: any) => ({
        ...p,
        _is_friend: friendIds.has(p.user_id),
      }));

      // AI scoring (privacy-aware)
      const aiScores = await aiScorePosts(profile, enrichedPosts, user.id, aiPersonalizationAllowed);

      return new Response(JSON.stringify({ scores: aiScores, profile_summary: {
        interests: profile.topInterests.slice(0, 5),
        engagement_rate: profile.engagementRate,
        friend_bias: profile.friendBias,
      }}), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ══════════════════════════════════════════════
    // RECOMMEND — AI-powered discovery suggestions
    // ══════════════════════════════════════════════
    if (action === "recommend") {
      const profile = await buildUserProfile(supabase, user.id);

      // Get recent viewed post IDs
      const { data: recentViews } = await supabase
        .from("user_behavior_signals")
        .select("post_id")
        .eq("user_id", user.id)
        .eq("signal_type", "view")
        .gte("created_at", new Date(Date.now() - 7 * 24 * 3600_000).toISOString())
        .limit(200);

      const seenPostIds = new Set<string>((recentViews || []).map((v: any) => v.post_id));

      // Get candidate posts from non-friends (discovery)
      const { data: friendships } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
        .eq("status", "accepted");

      const friendIds = new Set<string>();
      (friendships || []).forEach((f: any) => {
        friendIds.add(f.requester_id === user.id ? f.addressee_id : f.requester_id);
      });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { data: candidates } = await supabase
        .from("posts")
        .select("id, user_id, body, image_url, created_at, likes_count, comments_count")
        .gte("created_at", thirtyDaysAgo)
        .order("likes_count", { ascending: false })
        .limit(100);

      // Filter to non-friend posts only for discovery
      const discoveryPosts = (candidates || []).filter(
        (p: any) => !friendIds.has(p.user_id) && p.user_id !== user.id
      );

      const recommendedIds = await aiRecommend(profile, discoveryPosts, seenPostIds, aiPersonalizationAllowed);

      return new Response(JSON.stringify({
        recommended_post_ids: recommendedIds,
        discovery_pool_size: discoveryPosts.length,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ══════════════════════════════
    // PROFILE — Get user ML profile
    // ══════════════════════════════
    if (action === "profile") {
      const profile = await buildUserProfile(supabase, user.id);
      return new Response(JSON.stringify({ profile }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: "Unknown action. Use: track, score, recommend, profile" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("ml-feed error:", err);
    if (err instanceof Error && err.message.includes("Rate limit")) {
      return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez plus tard." }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
