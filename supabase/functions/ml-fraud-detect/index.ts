import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface FraudFeatures {
  login_velocity: number;      // logins per hour
  device_count: number;         // unique devices in 7d
  geo_jump_km: number;          // max distance between consecutive logins
  message_rate: number;         // messages per minute avg
  friend_request_rate: number;  // requests per day
  account_age_days: number;
  profile_completeness: number; // 0-1
  content_spam_ratio: number;   // flagged / total posts
  duplicate_content_pct: number;
  social_reciprocity: number;   // accepted / sent friend requests
}

function computeFraudScore(features: FraudFeatures): { score: number; signals: string[]; confidence: number } {
  const signals: string[] = [];
  let score = 0;
  let weights_used = 0;

  // 1. Login velocity anomaly (normal: <5/h, suspicious: >10/h)
  if (features.login_velocity > 15) { score += 25; signals.push('velocity_anomaly'); }
  else if (features.login_velocity > 10) { score += 12; signals.push('velocity_elevated'); }
  weights_used += 25;

  // 2. Device diversity (normal: 1-3, suspicious: >5)
  if (features.device_count > 8) { score += 20; signals.push('device_mismatch'); }
  else if (features.device_count > 5) { score += 10; signals.push('device_elevated'); }
  weights_used += 20;

  // 3. Geographic impossibility (>500km in <1h)
  if (features.geo_jump_km > 1000) { score += 20; signals.push('geo_impossible'); }
  else if (features.geo_jump_km > 500) { score += 10; signals.push('geo_suspicious'); }
  weights_used += 20;

  // 4. Message spam behavior
  if (features.message_rate > 5) { score += 10; signals.push('behavior_bot'); }
  else if (features.message_rate > 3) { score += 5; }
  weights_used += 10;

  // 5. Friend request spam
  if (features.friend_request_rate > 20) { score += 10; signals.push('request_spam'); }
  else if (features.friend_request_rate > 10) { score += 5; }
  weights_used += 10;

  // 6. New account + aggressive behavior
  if (features.account_age_days < 3 && score > 20) {
    score += 10; signals.push('new_account_aggressive');
  }
  weights_used += 10;

  // 7. Content patterns
  if (features.content_spam_ratio > 0.3) { score += 8; signals.push('content_spam'); }
  if (features.duplicate_content_pct > 0.5) { score += 7; signals.push('duplicate_content'); }
  weights_used += 15;

  // 8. Profile completeness (bots often have empty profiles)
  if (features.profile_completeness < 0.2 && features.account_age_days > 7) {
    score += 5; signals.push('empty_profile');
  }

  // 9. Social reciprocity (low = bot-like)
  if (features.social_reciprocity < 0.1 && features.friend_request_rate > 5) {
    score += 5; signals.push('low_reciprocity');
  }

  // Normalize score to 0-100
  const normalizedScore = Math.min(100, Math.round((score / weights_used) * 100));
  const confidence = Math.min(0.95, 0.5 + (features.account_age_days / 60) * 0.3 + (weights_used > 50 ? 0.15 : 0));

  return { score: normalizedScore, signals, confidence };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, target_user_id } = await req.json();

    // Authorization: a non-admin user can only scan THEMSELVES.
    // For batch_scan, the existing admin gate later in this file applies.
    let targetId = user.id;
    if (target_user_id && target_user_id !== user.id) {
      const { data: isAdmin } = await supabase.rpc("has_role", {
        _user_id: user.id,
        _role: "admin",
      });
      if (isAdmin !== true) {
        return new Response(JSON.stringify({ error: "FORBIDDEN" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      targetId = target_user_id;
    }

    if (action === "scan") {
      const start = performance.now();

      // Gather features from database
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // Parallel data fetching
      const [
        fingerprintsRes,
        profileRes,
        messagesRes,
        friendshipsRes,
        postsRes,
        strikesRes,
      ] = await Promise.all([
        supabase.from("device_fingerprints").select("id, last_seen_at, ip_address").eq("user_id", targetId).gte("last_seen_at", sevenDaysAgo.toISOString()),
        supabase.from("profiles").select("name, avatar_url, bio, city, interests, created_at").eq("user_id", targetId).single(),
        supabase.from("messages").select("id, created_at").eq("sender_id", targetId).gte("created_at", oneDayAgo.toISOString()),
        supabase.from("friendships").select("id, status, requester_id").or(`requester_id.eq.${targetId},addressee_id.eq.${targetId}`),
        supabase.from("posts").select("id, body, created_at").eq("user_id", targetId).gte("created_at", sevenDaysAgo.toISOString()),
        supabase.from("content_strikes").select("id").eq("user_id", targetId),
      ]);

      const fingerprints = fingerprintsRes.data || [];
      const profile = profileRes.data;
      const messages = messagesRes.data || [];
      const friendships = friendshipsRes.data || [];
      const posts = postsRes.data || [];
      const strikes = strikesRes.data || [];

      // Compute features
      const accountAge = profile?.created_at
        ? Math.floor((now.getTime() - new Date(profile.created_at).getTime()) / (24 * 60 * 60 * 1000))
        : 0;

      const recentFingerprints = fingerprints.filter(
        (f: any) => new Date(f.last_seen_at) >= oneHourAgo
      );

      const sentRequests = friendships.filter((f: any) => f.requester_id === targetId);
      const acceptedRequests = friendships.filter((f: any) => f.status === "accepted" && f.requester_id === targetId);

      // Duplicate content detection
      const postBodies = posts.map((p: any) => p.body?.trim().toLowerCase()).filter(Boolean);
      const uniqueBodies = new Set(postBodies);
      const duplicatePct = postBodies.length > 0 ? 1 - (uniqueBodies.size / postBodies.length) : 0;

      // Profile completeness
      let completeness = 0;
      if (profile?.name) completeness += 0.25;
      if (profile?.avatar_url) completeness += 0.25;
      if (profile?.bio) completeness += 0.25;
      if (profile?.interests && profile.interests.length > 0) completeness += 0.25;

      const features: FraudFeatures = {
        login_velocity: recentFingerprints.length,
        device_count: new Set(fingerprints.map((f: any) => f.ip_address)).size,
        geo_jump_km: 0, // Would need real geo data
        message_rate: messages.length / 24,
        friend_request_rate: sentRequests.filter(
          (f: any) => new Date(f.created_at || now) >= oneDayAgo
        ).length,
        account_age_days: accountAge,
        profile_completeness: completeness,
        content_spam_ratio: posts.length > 0 ? strikes.length / posts.length : 0,
        duplicate_content_pct: duplicatePct,
        social_reciprocity: sentRequests.length > 0 ? acceptedRequests.length / sentRequests.length : 0.5,
      };

      const result = computeFraudScore(features);
      const latency = Math.round(performance.now() - start);

      // Log prediction
      await supabase.from("ml_predictions").insert({
        domain: "fraud",
        user_id: targetId,
        target_id: targetId,
        target_type: "user",
        prediction: { label: result.score > 60 ? "fraud" : result.score > 30 ? "suspicious" : "clean", score: result.score, signals: result.signals, features },
        confidence: result.confidence,
        latency_ms: latency,
      });

      // If high risk, create fraud signal
      if (result.score > 40) {
        for (const signal of result.signals) {
          await supabase.from("ml_fraud_signals").insert({
            user_id: targetId,
            signal_type: signal,
            risk_score: result.score,
            details: { features, all_signals: result.signals },
          });
        }
      }

      return new Response(JSON.stringify({
        risk_score: result.score,
        risk_level: result.score > 60 ? "high" : result.score > 30 ? "medium" : "low",
        signals: result.signals,
        confidence: result.confidence,
        features,
        latency_ms: latency,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "batch_scan") {
      // Admin-only batch scan
      const isAdmin = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
      if (!isAdmin.data) {
        return new Response(JSON.stringify({ error: "Admin requis" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get recent active users
      const { data: recentUsers } = await supabase
        .from("profiles")
        .select("user_id")
        .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .limit(50);

      const results: any[] = [];
      for (const u of recentUsers || []) {
        // Lightweight scan — in production would call the scan action internally
        results.push({ user_id: u.user_id, status: "queued" });
      }

      return new Response(JSON.stringify({ queued: results.length, users: results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Action inconnue" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("ML Fraud Detection error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erreur interne" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
