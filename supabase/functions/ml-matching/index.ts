import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rate-limit.ts";

interface MatchFeatures {
  interest_overlap: number;   // 0-1 Jaccard similarity
  behavior_similarity: number; // 0-1 cosine similarity of activity patterns
  geo_proximity: number;       // 0-1 (1 = same city)
  mutual_friends: number;      // count
  activity_compatibility: number; // 0-1 (active at same hours)
  age_proximity: number;       // 0-1
  content_style_match: number; // 0-1 (similar posting style)
}

function computeMatchScore(features: MatchFeatures): number {
  const weights = {
    interest_overlap: 0.30,
    behavior_similarity: 0.15,
    geo_proximity: 0.15,
    mutual_friends: 0.20,
    activity_compatibility: 0.10,
    age_proximity: 0.05,
    content_style_match: 0.05,
  };

  let score = 0;
  score += features.interest_overlap * weights.interest_overlap;
  score += features.behavior_similarity * weights.behavior_similarity;
  score += features.geo_proximity * weights.geo_proximity;
  score += Math.min(1, features.mutual_friends / 10) * weights.mutual_friends;
  score += features.activity_compatibility * weights.activity_compatibility;
  score += features.age_proximity * weights.age_proximity;
  score += features.content_style_match * weights.content_style_match;

  return Math.round(score * 100);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (!a?.length || !b?.length) return 0;
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rateLimited = await checkRateLimit(`ml-matching:${user.id}`, 30, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const { action, limit = 20 } = await req.json();

    if (action === "suggest") {
      const start = performance.now();

      // Get current user profile + interests
      const [profileRes, interestsRes, behaviorRes] = await Promise.all([
        supabase.from("profiles").select("*").eq("user_id", user.id).single(),
        supabase.from("user_interests").select("interest_value").eq("user_id", user.id),
        supabase.from("user_behavior_signals").select("signal_type, post_id, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
      ]);

      const myProfile = profileRes.data;
      const myInterests = (interestsRes.data || []).map((i: any) => i.interest_value);
      const myBehavior = behaviorRes.data || [];

      // Get existing friends & pending
      const { data: friendships } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id, status")
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

      const friendIds = new Set<string>();
      const pendingIds = new Set<string>();
      for (const f of friendships || []) {
        const otherId = f.requester_id === user.id ? f.addressee_id : f.requester_id;
        if (f.status === "accepted") friendIds.add(otherId);
        else pendingIds.add(otherId);
      }

      // Get candidate users (exclude friends, pending, self)
      const excludeIds = [user.id, ...friendIds, ...pendingIds];
      const { data: candidates } = await supabase
        .from("profiles")
        .select("user_id, name, avatar_url, bio, city, interests, date_of_birth, created_at")
        .not("user_id", "in", `(${excludeIds.join(",")})`)
        .limit(200);

      if (!candidates?.length) {
        return new Response(JSON.stringify({ suggestions: [], features: {} }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get candidates' interests
      const candidateIds = candidates.map((c: any) => c.user_id);
      const { data: candidateInterests } = await supabase
        .from("user_interests")
        .select("user_id, interest_value")
        .in("user_id", candidateIds);

      const interestMap = new Map<string, string[]>();
      for (const ci of candidateInterests || []) {
        if (!interestMap.has(ci.user_id)) interestMap.set(ci.user_id, []);
        interestMap.get(ci.user_id)!.push(ci.interest_value);
      }

      // Get mutual friends count for candidates
      const { data: candidateFriendships } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .eq("status", "accepted")
        .or(candidateIds.map((id: string) => `requester_id.eq.${id},addressee_id.eq.${id}`).join(","));

      const mutualCount = new Map<string, number>();
      for (const cf of candidateFriendships || []) {
        for (const cid of candidateIds) {
          const otherInFriendship = cf.requester_id === cid ? cf.addressee_id : (cf.addressee_id === cid ? cf.requester_id : null);
          if (otherInFriendship && friendIds.has(otherInFriendship)) {
            mutualCount.set(cid, (mutualCount.get(cid) || 0) + 1);
          }
        }
      }

      // Activity pattern (hours active)
      const myHours = new Set(myBehavior.map((b: any) => new Date(b.created_at).getHours()));

      // Score each candidate
      const scored = candidates.map((candidate: any) => {
        const candidateInts = interestMap.get(candidate.user_id) || candidate.interests || [];
        
        const features: MatchFeatures = {
          interest_overlap: jaccardSimilarity(myInterests, candidateInts),
          behavior_similarity: 0.5, // baseline, enhanced with more data
          geo_proximity: myProfile?.city && candidate.city && myProfile.city.toLowerCase() === candidate.city.toLowerCase() ? 1 : 0,
          mutual_friends: mutualCount.get(candidate.user_id) || 0,
          activity_compatibility: 0.5,
          age_proximity: 0.5,
          content_style_match: 0.5,
        };

        // Age proximity
        if (myProfile?.date_of_birth && candidate.date_of_birth) {
          const myAge = Math.abs(new Date().getFullYear() - new Date(myProfile.date_of_birth).getFullYear());
          const theirAge = Math.abs(new Date().getFullYear() - new Date(candidate.date_of_birth).getFullYear());
          const ageDiff = Math.abs(myAge - theirAge);
          features.age_proximity = Math.max(0, 1 - ageDiff / 20);
        }

        const score = computeMatchScore(features);

        return {
          user_id: candidate.user_id,
          name: candidate.name,
          avatar_url: candidate.avatar_url,
          bio: candidate.bio,
          city: candidate.city,
          match_score: score,
          match_reasons: [
            features.interest_overlap > 0.3 ? `${Math.round(features.interest_overlap * 100)}% intérêts communs` : null,
            features.mutual_friends > 0 ? `${features.mutual_friends} ami(s) en commun` : null,
            features.geo_proximity > 0 ? "Même ville" : null,
          ].filter(Boolean),
          features,
        };
      });

      // Sort by score and take top N
      scored.sort((a: any, b: any) => b.match_score - a.match_score);
      const suggestions = scored.slice(0, Math.min(limit, 50));

      const latency = Math.round(performance.now() - start);

      // Log prediction
      await supabase.from("ml_predictions").insert({
        domain: "matching",
        user_id: user.id,
        target_id: user.id,
        target_type: "user",
        prediction: { count: suggestions.length, top_score: suggestions[0]?.match_score },
        confidence: 0.7,
        latency_ms: latency,
      });

      return new Response(JSON.stringify({ suggestions, latency_ms: latency }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Action inconnue" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("ML Matching error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erreur interne" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
