import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ddosShield } from "../_shared/ddos-shield.ts";

// Rate limits per action type (per hour)
const RATE_LIMITS: Record<string, number> = {
  post: 20,
  comment: 60,
  like: 200,
  message: 100,
  report: 10,
  purchase: 15,
  friend_request: 30,
  story: 15,
  login: 10,
};

// Bot behavior patterns
function detectBotBehavior(actions: any[]): {
  isBot: boolean;
  confidence: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let botScore = 0;

  if (actions.length < 5) return { isBot: false, confidence: 0, reasons: [] };

  // 1. Too-regular intervals (bots act at precise intervals)
  const intervals: number[] = [];
  for (let i = 1; i < actions.length; i++) {
    intervals.push(
      new Date(actions[i].created_at).getTime() -
        new Date(actions[i - 1].created_at).getTime()
    );
  }
  if (intervals.length >= 3) {
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance =
      intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) /
      intervals.length;
    const stdDev = Math.sqrt(variance);
    // Very low variance = bot-like regularity
    if (stdDev < 500 && avgInterval < 5000) {
      botScore += 40;
      reasons.push("Suspiciously regular action intervals");
    }
  }

  // 2. Burst activity (too many actions in short window)
  const last5MinActions = actions.filter(
    (a: any) =>
      Date.now() - new Date(a.created_at).getTime() < 5 * 60 * 1000
  );
  if (last5MinActions.length > 30) {
    botScore += 30;
    reasons.push("Excessive burst activity");
  }

  // 3. Night-time sustained activity (suspicious if constant 24/7)
  const nightActions = actions.filter((a: any) => {
    const hour = new Date(a.created_at).getHours();
    return hour >= 2 && hour <= 5;
  });
  if (nightActions.length > actions.length * 0.4) {
    botScore += 20;
    reasons.push("Unusual night-time activity pattern");
  }

  return {
    isBot: botScore >= 50,
    confidence: Math.min(100, botScore),
    reasons,
  };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
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
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const userClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = { id: claimsData.claims.sub as string };

    const body = await req.json();
    const { action } = body;

    // ── CHECK RATE LIMIT ──
    if (action === "check_rate") {
      const { actionType } = body;
      const maxActions = RATE_LIMITS[actionType] || 50;

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: existing } = await supabase
        .from("rate_limits")
        .select("id, action_count")
        .eq("user_id", user.id)
        .eq("action_type", actionType)
        .gte("window_start", oneHourAgo)
        .maybeSingle();

      if (existing && existing.action_count >= maxActions) {
        // Flag in trust score
        await supabase
          .from("trust_scores")
          .update({ is_flagged: true, flag_reason: `Rate limit exceeded: ${actionType}` })
          .eq("user_id", user.id);

        return new Response(
          JSON.stringify({
            allowed: false,
            reason: "Rate limit exceeded",
            remaining: 0,
            resetIn: "1 hour",
          }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Upsert rate limit counter
      if (existing) {
        await supabase
          .from("rate_limits")
          .update({ action_count: existing.action_count + 1 })
          .eq("id", existing.id);
      } else {
        await supabase.from("rate_limits").insert({
          user_id: user.id,
          action_type: actionType,
          action_count: 1,
          window_start: new Date().toISOString(),
          window_end: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }

      const currentCount = (existing?.action_count || 0) + 1;
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining: maxActions - currentCount,
          total: maxActions,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ── FINGERPRINT REGISTRATION ──
    if (action === "register_fingerprint") {
      const { fingerprintHash, screenResolution, timezone, language } = body;
      const userAgent = req.headers.get("User-Agent") || "";
      const ip =
        req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
        req.headers.get("CF-Connecting-IP") ||
        "unknown";

      // Check for multi-account: same fingerprint, different user
      const { data: existingFingerprints } = await supabase
        .from("device_fingerprints")
        .select("user_id")
        .eq("fingerprint_hash", fingerprintHash)
        .neq("user_id", user.id);

      const multiAccountDetected =
        existingFingerprints && existingFingerprints.length > 0;
      const linkedAccounts = multiAccountDetected
        ? existingFingerprints.map((f: any) => f.user_id)
        : [];

      // Upsert fingerprint
      const { data: existingOwn } = await supabase
        .from("device_fingerprints")
        .select("id")
        .eq("user_id", user.id)
        .eq("fingerprint_hash", fingerprintHash)
        .maybeSingle();

      if (existingOwn) {
        await supabase
          .from("device_fingerprints")
          .update({
            last_seen_at: new Date().toISOString(),
            ip_address: ip,
            user_agent: userAgent,
          })
          .eq("id", existingOwn.id);
      } else {
        await supabase.from("device_fingerprints").insert({
          user_id: user.id,
          fingerprint_hash: fingerprintHash,
          ip_address: ip,
          user_agent: userAgent,
          screen_resolution: screenResolution || null,
          timezone: timezone || null,
          language: language || null,
        });
      }

      // If multi-account, flag both
      if (multiAccountDetected) {
        for (const linkedId of linkedAccounts) {
          await supabase
            .from("trust_scores")
            .update({
              is_flagged: true,
              flag_reason: "Multi-account detected",
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", linkedId);
        }
        await supabase
          .from("trust_scores")
          .update({
            is_flagged: true,
            flag_reason: "Multi-account detected",
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id);
      }

      return new Response(
        JSON.stringify({
          registered: true,
          multiAccountDetected,
          linkedAccountCount: linkedAccounts.length,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ── BOT DETECTION ──
    if (action === "check_bot") {
      // Get recent rate limit entries as proxy for activity
      const { data: recentActions } = await supabase
        .from("rate_limits")
        .select("action_type, action_count, window_start, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      const result = detectBotBehavior(recentActions || []);

      if (result.isBot) {
        await supabase
          .from("trust_scores")
          .update({
            is_flagged: true,
            flag_reason: `Bot detected: ${result.reasons.join(", ")}`,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id);
      }

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── REPORT USER ──
    if (action === "report_user") {
      const { reportedUserId, reportType, description } = body;

      if (!reportedUserId || !reportType) {
        return new Response(
          JSON.stringify({ error: "reportedUserId and reportType required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const { data, error } = await supabase
        .from("abuse_reports")
        .insert({
          reporter_id: user.id,
          reported_user_id: reportedUserId,
          report_type: reportType,
          description: description || null,
        })
        .select()
        .single();

      if (error) throw error;

      // Auto-flag if many reports
      const { count } = await supabase
        .from("abuse_reports")
        .select("id", { count: "exact", head: true })
        .eq("reported_user_id", reportedUserId)
        .eq("status", "pending");

      if (count && count >= 5) {
        await supabase
          .from("trust_scores")
          .update({
            is_flagged: true,
            flag_reason: `Multiple abuse reports (${count})`,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", reportedUserId);
      }

      return new Response(JSON.stringify({ report: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── MINOR CONTACT DETECTION ──
    if (action === "check_minor_contact") {
      const { targetUserId } = body;

      // Check if target is minor
      const { data: minorCheck } = await supabase
        .from("parental_controls")
        .select("is_active")
        .eq("user_id", targetUserId)
        .eq("is_active", true)
        .maybeSingle();

      if (!minorCheck) {
        return new Response(JSON.stringify({ flagged: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Log the contact attempt
      await supabase.from("minor_contact_logs").insert({
        adult_user_id: user.id,
        minor_user_id: targetUserId,
        contact_type: body.contactType || "message",
      });

      // Check how many different minors this adult has contacted in last 24h
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentContacts } = await supabase
        .from("minor_contact_logs")
        .select("minor_user_id")
        .eq("adult_user_id", user.id)
        .gte("created_at", oneDayAgo);

      const uniqueMinors = new Set(
        (recentContacts || []).map((c: any) => c.minor_user_id)
      );

      let flagged = false;

      // Alert if adult contacts 3+ different minors in 24h
      if (uniqueMinors.size >= 3) {
        flagged = true;
        await supabase
          .from("trust_scores")
          .update({
            is_flagged: true,
            flag_reason: `Suspicious: contacted ${uniqueMinors.size} minors in 24h`,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id);
      }

      // Check repeated contact attempts to same minor
      const { data: repeatedAttempts } = await supabase
        .from("minor_contact_logs")
        .select("id")
        .eq("adult_user_id", user.id)
        .eq("minor_user_id", targetUserId)
        .gte("created_at", oneDayAgo);

      if ((repeatedAttempts?.length || 0) >= 5) {
        flagged = true;
        await supabase
          .from("trust_scores")
          .update({
            is_flagged: true,
            flag_reason: `Repeated contact attempts to minor`,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id);
      }

      return new Response(
        JSON.stringify({
          flagged,
          uniqueMinorsContacted: uniqueMinors.size,
          repeatedAttempts: repeatedAttempts?.length || 0,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
      error:
          "Invalid action. Use: check_rate, register_fingerprint, check_bot, report_user, check_minor_contact",
      }),
      {
        status: 400,
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
