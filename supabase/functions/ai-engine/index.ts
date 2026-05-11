import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 60 * 1000;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function safeJson(value: unknown, maxLen = 8000): string {
  try {
    return JSON.stringify(value || {}).slice(0, maxLen);
  } catch {
    return "{}";
  }
}

function redactSecurityContext(input: Record<string, unknown>) {
  const blocked = new Set(["password", "token", "authorization", "cookie", "secret", "service_role", "api_key", "private_key"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input || {})) {
    const lk = k.toLowerCase();
    if ([...blocked].some((b) => lk.includes(b))) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = typeof v === "string" ? v.slice(0, 1000) : v;
    }
  }
  return out;
}

async function logSecurityAIResult(supabase: ReturnType<typeof createClient>, userId: string, action: string, result: unknown, context: Record<string, unknown>) {
  try {
    await supabase.from("security_ai_events" as any).insert({
      user_id: userId,
      action,
      result,
      context: redactSecurityContext(context),
    });
  } catch {
    // Optional table. Never break AI engine because audit table is missing.
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: authUser }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authUser) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!checkRateLimit(authUser.id)) {
      return new Response(JSON.stringify({ error: "Trop de requêtes IA, réessayez dans un moment" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const { action, text, context, feedback } = body;
    const user_id = authUser.id;
    const MAX_TEXT_LENGTH = 5000;
    const safeText = typeof text === "string" ? text.slice(0, MAX_TEXT_LENGTH) : "";
    const safeContext = context && typeof context === "object" ? redactSecurityContext(context) : {};

    if (!action || typeof action !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'action' parameter" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "moderate" && safeText) {
      const contentHash = hashContent(safeText.trim().toLowerCase());
      const { data: cached } = await supabase
        .from("ai_moderation_cache")
        .select("result")
        .eq("content_hash", contentHash)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (cached?.result) {
        return new Response(JSON.stringify({ result: cached.result, cached: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    let learnedRulesContext = "";
    if (action === "moderate") {
      const { data: rules } = await supabase
        .from("ai_learned_rules")
        .select("rule")
        .order("created_at", { ascending: false })
        .limit(30);
      if (rules && rules.length > 0) {
        learnedRulesContext = "\n\nLEARNED RULES FROM PREVIOUS FEEDBACK (apply these):\n" + rules.map((r: { rule: string }) => `- ${r.rule}`).join("\n");
      }
    }

    let systemPrompt = "";
    let userPrompt = "";
    let securityAction = false;

    switch (action) {
      case "moderate": {
        systemPrompt = `You are ForSure's AI content moderator. Analyze the following content and return a JSON object with these fields:
- "safe": boolean
- "score": number 0-100
- "categories": string[] from: "spam", "hate_speech", "harassment", "violence", "sexual", "misinformation", "self_harm", "illegal", "profanity"
- "sentiment": string
- "emotion": string
- "confidence": number 0-100
- "suggestion": string
- "auto_action": string from: "allow", "flag_review", "shadow_ban", "remove"
Be culturally aware. Consider French slang and context. Do NOT over-flag casual language. Only output valid JSON.${learnedRulesContext}`;
        userPrompt = safeText;
        break;
      }
      case "analyze_sentiment": {
        systemPrompt = `You are an expert sentiment and emotion analyzer for a French social network. Return valid JSON with sentiment, emotion, secondary_emotions, intensity, topics, engagement_prediction, virality_score.`;
        userPrompt = safeText;
        break;
      }
      case "recommend": {
        systemPrompt = `You are ForSure's recommendation engine. Return valid JSON with content_types, topics, time_slots, diversity_suggestions, fatigue_risk, personality_type.`;
        userPrompt = safeJson(safeContext);
        break;
      }
      case "profile_risk": {
        systemPrompt = `You are ForSure's user risk assessment AI. Return valid JSON: risk_level safe|low|medium|high|critical, risk_factors, behavior_pattern, recommended_actions, trust_score.`;
        userPrompt = safeJson(safeContext);
        break;
      }
      case "detect_intrusion": {
        securityAction = true;
        systemPrompt = `You are ForSure's defensive intrusion detection analyst. Analyze ONLY defensive application/security telemetry. Return valid JSON:
- "threat_detected": boolean
- "severity": "none"|"low"|"medium"|"high"|"critical"
- "attack_types": string[] from: "credential_stuffing", "session_hijack", "xss_attempt", "sql_injection_attempt", "api_abuse", "ddos_pattern", "privilege_escalation", "bot_activity", "unknown"
- "confidence": number 0-100
- "evidence": string[] short observable signals, no secrets
- "recommended_actions": string[] defensive actions only
- "should_create_incident": boolean
- "cooldown_seconds": number
Do not provide offensive exploitation steps. Do not include secrets. If uncertain, lower confidence.`;
        userPrompt = safeJson(safeContext);
        break;
      }
      case "analyze_ip": {
        securityAction = true;
        systemPrompt = `You are a defensive IP and request reputation analyzer for ForSure. Return valid JSON:
- "risk_level": "safe"|"low"|"medium"|"high"|"critical"
- "risk_score": number 0-100
- "signals": string[]
- "likely_actor": "human"|"bot"|"scanner"|"unknown"
- "recommended_rate_limit": string
- "block_recommended": boolean
- "review_required": boolean
Use only provided telemetry. No offensive advice.`;
        userPrompt = safeJson(safeContext);
        break;
      }
      case "inspect_packet": {
        securityAction = true;
        systemPrompt = `You are a defensive HTTP/API request inspector. Analyze request metadata/payload snippets for abuse. Return valid JSON:
- "malicious": boolean
- "severity": "none"|"low"|"medium"|"high"|"critical"
- "patterns": string[] from: "xss", "sql_injection", "path_traversal", "command_injection", "spam", "bot", "oversized_payload", "suspicious_user_agent", "none"
- "safe_summary": string
- "recommended_actions": string[] defensive only
Never output executable exploit payloads. Redact sensitive data.`;
        userPrompt = safeJson(safeContext);
        break;
      }
      case "scan_vulnerabilities": {
        securityAction = true;
        systemPrompt = `You are a defensive application security reviewer for ForSure. Analyze configuration/code metadata supplied by the app. Return valid JSON:
- "findings": {"severity":"low"|"medium"|"high"|"critical","title":string,"description":string,"fix":string}[]
- "overall_risk": "low"|"medium"|"high"|"critical"
- "priority_order": string[]
Focus on defensive fixes: RLS, auth, CSP, upload validation, rate limit, secrets, CORS. Do not provide exploit instructions.`;
        userPrompt = safeJson(safeContext);
        break;
      }
      case "analyze_session": {
        securityAction = true;
        systemPrompt = `You are ForSure's session guardian. Analyze session/device telemetry defensively. Return valid JSON:
- "session_risk": "safe"|"low"|"medium"|"high"|"critical"
- "risk_score": number 0-100
- "anomalies": string[]
- "recommended_actions": string[] from: "allow", "step_up_auth", "refresh_session", "revoke_session", "notify_user", "lock_account_review"
- "device_trust_delta": number from -100 to 100
- "requires_user_notification": boolean`;
        userPrompt = safeJson(safeContext);
        break;
      }
      case "smart_reply": {
        systemPrompt = `You are ForSure's smart reply generator. Return valid JSON with exactly 3 short replies and detected tone. Same language as conversation.`;
        userPrompt = safeText;
        break;
      }
      case "content_enhance": {
        systemPrompt = `You are ForSure's content enhancement AI. Return valid JSON with enhanced, hashtags, improvements, readability_before, readability_after, engagement_boost_estimate.`;
        userPrompt = safeText;
        break;
      }
      case "learn_feedback": {
        if (feedback && user_id) {
          const { data: insertedFeedback } = await supabase.from("ai_feedback").insert({ user_id, original_text: feedback.originalText || "", ai_decision: feedback.aiDecision || "", human_decision: feedback.humanDecision || "", reason: feedback.reason || "" }).select("id").single();
          const { data: recentFeedback } = await supabase.from("ai_feedback").select("original_text, ai_decision, human_decision, reason").order("created_at", { ascending: false }).limit(20);
          systemPrompt = `You are a self-learning AI moderator. Return valid JSON: acknowledged, adjustment, new_rules, pattern.`;
          userPrompt = safeJson({ current_feedback: feedback, recent_history: recentFeedback || [] });
          const aiResult = await callAI(LOVABLE_API_KEY, systemPrompt, userPrompt, "google/gemini-2.5-flash");
          if (aiResult?.new_rules && Array.isArray(aiResult.new_rules)) {
            for (const rule of aiResult.new_rules) await supabase.from("ai_learned_rules").insert({ rule, source_feedback_id: insertedFeedback?.id || null, pattern: aiResult.pattern || null });
          }
          await supabase.from("ai_moderation_cache").delete().lt("expires_at", new Date(Date.now() + 999999999).toISOString());
          return new Response(JSON.stringify({ result: aiResult }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: "Missing feedback or user_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      case "get_feedback_history": {
        const { data: feedbackData } = await supabase.from("ai_feedback").select("*").eq("user_id", user_id).order("created_at", { ascending: false }).limit(50);
        const { data: rulesData } = await supabase.from("ai_learned_rules").select("*").order("created_at", { ascending: false }).limit(50);
        return new Response(JSON.stringify({ result: { feedback: feedbackData || [], rules: rulesData || [] } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const cheapActions = ["moderate", "smart_reply", "detect_intrusion", "analyze_ip", "inspect_packet", "analyze_session"];
    const model = cheapActions.includes(action) ? "google/gemini-2.5-flash-lite" : "google/gemini-2.5-flash";
    const result = await callAI(LOVABLE_API_KEY, systemPrompt, userPrompt, model);

    if (action === "moderate" && result && safeText) {
      const contentHash = hashContent(safeText.trim().toLowerCase());
      await supabase.from("ai_moderation_cache").upsert({ content_hash: contentHash, result, expires_at: new Date(Date.now() + 6 * 3600000).toISOString() }, { onConflict: "content_hash" }).select();
    }

    if (securityAction) await logSecurityAIResult(supabase, user_id, action, result, safeContext);

    return new Response(JSON.stringify({ result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("ai-engine error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function callAI(apiKey: string, systemPrompt: string, userPrompt: string, model = "google/gemini-2.5-flash") {
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] }),
  });

  if (!response.ok) {
    const status = response.status;
    const body = await response.text().catch(() => "");
    console.error(`AI gateway ${status}:`, body);
    if (status === 429) throw new Error("Trop de requêtes IA");
    if (status === 402) throw new Error("Crédits IA insuffisants");
    throw new Error(`Erreur du service IA (${status})`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    console.error("AI JSON parse error, raw:", raw.slice(0, 500));
    return { raw, parse_error: true };
  }
}
