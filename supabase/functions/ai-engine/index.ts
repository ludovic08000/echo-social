import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Simple hash for cache key
function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ─── Auth check ───
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: authUser }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authUser) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action, text, context, feedback } = body;
    const user_id = authUser.id; // Always use authenticated user ID, never trust client

    if (!action || typeof action !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing 'action' parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Server-side cache check for moderation ──
    if (action === "moderate" && text) {
      const contentHash = hashContent(text.trim().toLowerCase());
      const { data: cached } = await supabase
        .from("ai_moderation_cache")
        .select("result")
        .eq("content_hash", contentHash)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (cached?.result) {
        return new Response(
          JSON.stringify({ result: cached.result, cached: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Load learned rules to enhance moderation context ──
    let learnedRulesContext = "";
    if (action === "moderate") {
      const { data: rules } = await supabase
        .from("ai_learned_rules")
        .select("rule")
        .order("created_at", { ascending: false })
        .limit(30);

      if (rules && rules.length > 0) {
        learnedRulesContext = "\n\nLEARNED RULES FROM PREVIOUS FEEDBACK (apply these):\n" +
          rules.map((r: { rule: string }) => `- ${r.rule}`).join("\n");
      }
    }

    let systemPrompt = "";
    let userPrompt = "";

    switch (action) {
      case "moderate": {
        systemPrompt = `You are ForSure's AI content moderator. Analyze the following content and return a JSON object with these fields:
- "safe": boolean (true if content is safe)
- "score": number 0-100 (toxicity score, 0=safe, 100=extremely toxic)
- "categories": string[] (detected issues from: "spam", "hate_speech", "harassment", "violence", "sexual", "misinformation", "self_harm", "illegal", "profanity")
- "sentiment": string (one of: "very_positive", "positive", "neutral", "negative", "very_negative")
- "emotion": string (primary emotion: "joy", "anger", "sadness", "fear", "surprise", "disgust", "trust", "anticipation")
- "confidence": number 0-100 (how confident you are in this assessment)
- "suggestion": string (brief moderation suggestion if unsafe, empty if safe)
- "auto_action": string (one of: "allow", "flag_review", "shadow_ban", "remove")

Be culturally aware. Consider French slang and context. Do NOT over-flag casual language.
Only output valid JSON, nothing else.${learnedRulesContext}`;
        userPrompt = text || "";
        break;
      }

      case "analyze_sentiment": {
        systemPrompt = `You are an expert sentiment and emotion analyzer for a French social network. Analyze the text and return JSON:
- "sentiment": string ("very_positive", "positive", "neutral", "negative", "very_negative")
- "emotion": string (primary: "joy", "anger", "sadness", "fear", "surprise", "disgust", "trust", "anticipation")
- "secondary_emotions": string[] (up to 2 secondary emotions)
- "intensity": number 0-100
- "topics": string[] (detected topics/themes, up to 5)
- "engagement_prediction": string ("high", "medium", "low")
- "virality_score": number 0-100
Only output valid JSON.`;
        userPrompt = text || "";
        break;
      }

      case "recommend": {
        systemPrompt = `You are ForSure's recommendation engine. Given the user's interest profile and recent activity, suggest content strategies. Return JSON:
- "content_types": string[] (recommended content types to show more of)
- "topics": string[] (topics the user would enjoy)
- "time_slots": string[] (best times to show content to this user)
- "diversity_suggestions": string[] (new topics to introduce for diversity)
- "fatigue_risk": string ("low", "medium", "high")
- "personality_type": string (detected personality archetype)
Only output valid JSON.`;
        userPrompt = JSON.stringify(context || {});
        break;
      }

      case "learn_feedback": {
        // Store feedback in DB
        if (feedback && user_id) {
          const { data: insertedFeedback } = await supabase
            .from("ai_feedback")
            .insert({
              user_id,
              original_text: feedback.originalText || "",
              ai_decision: feedback.aiDecision || "",
              human_decision: feedback.humanDecision || "",
              reason: feedback.reason || "",
            })
            .select("id")
            .single();

          // Load recent feedback for context
          const { data: recentFeedback } = await supabase
            .from("ai_feedback")
            .select("original_text, ai_decision, human_decision, reason")
            .order("created_at", { ascending: false })
            .limit(20);

          systemPrompt = `You are a self-learning AI moderator. You received feedback on a previous moderation decision, along with recent feedback history. Analyze and return JSON:
- "acknowledged": boolean
- "adjustment": string (what would you adjust in future similar cases)
- "new_rules": string[] (any new rules to derive from this feedback, be specific and actionable)
- "pattern": string (describe the pattern that should be learned)
Only output valid JSON.`;
          userPrompt = JSON.stringify({
            current_feedback: feedback,
            recent_history: recentFeedback || [],
          });

          // Call AI then store rules
          const aiResult = await callAI(LOVABLE_API_KEY, systemPrompt, userPrompt);
          
          if (aiResult?.new_rules && Array.isArray(aiResult.new_rules)) {
            for (const rule of aiResult.new_rules) {
              await supabase.from("ai_learned_rules").insert({
                rule,
                source_feedback_id: insertedFeedback?.id || null,
                pattern: aiResult.pattern || null,
              });
            }
          }

          // Clear moderation cache since rules changed
          await supabase.from("ai_moderation_cache").delete().lt("expires_at", new Date(Date.now() + 999999999).toISOString());

          return new Response(
            JSON.stringify({ result: aiResult }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ error: "Missing feedback or user_id" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "profile_risk": {
        systemPrompt = `You are ForSure's user risk assessment AI. Analyze a user's behavioral patterns and return JSON:
- "risk_level": string ("safe", "low", "medium", "high", "critical")
- "risk_factors": string[] (specific concerns identified)
- "behavior_pattern": string (describe the behavioral pattern)
- "recommended_actions": string[] (what actions to take)
- "trust_score": number 0-100 (overall trust score)
Only output valid JSON.`;
        userPrompt = JSON.stringify(context || {});
        break;
      }

      case "smart_reply": {
        systemPrompt = `You are ForSure's smart reply generator. Given the context of a conversation, suggest 3 quick replies that are natural, helpful and match the tone. Return JSON:
- "replies": string[] (exactly 3 suggested replies, short and natural)
- "tone": string (detected conversation tone)
Only output valid JSON. Replies should be in the same language as the conversation.`;
        userPrompt = text || "";
        break;
      }

      case "content_enhance": {
        systemPrompt = `You are ForSure's content enhancement AI. Improve the given post text. Return JSON:
- "enhanced": string (improved version of the text)
- "hashtags": string[] (suggested hashtags, up to 5)
- "improvements": string[] (what was improved)
- "readability_before": number 0-100
- "readability_after": number 0-100
- "engagement_boost_estimate": number (percentage increase in expected engagement)
Only output valid JSON. Keep the same language and tone.`;
        userPrompt = text || "";
        break;
      }

      case "get_feedback_history": {
        if (!user_id) {
          return new Response(
            JSON.stringify({ error: "Missing user_id" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const { data: feedbackData } = await supabase
          .from("ai_feedback")
          .select("*")
          .eq("user_id", user_id)
          .order("created_at", { ascending: false })
          .limit(50);

        const { data: rulesData } = await supabase
          .from("ai_learned_rules")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50);

        return new Response(
          JSON.stringify({ result: { feedback: feedbackData || [], rules: rulesData || [] } }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    const result = await callAI(LOVABLE_API_KEY, systemPrompt, userPrompt);

    // Cache moderation results server-side
    if (action === "moderate" && result && text) {
      const contentHash = hashContent(text.trim().toLowerCase());
      await supabase.from("ai_moderation_cache").upsert({
        content_hash: contentHash,
        result,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }, { onConflict: "content_hash" }).select();
    }

    return new Response(
      JSON.stringify({ result }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("ai-engine error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function callAI(apiKey: string, systemPrompt: string, userPrompt: string) {
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    if (response.status === 429) throw new Error("Trop de requêtes IA");
    if (response.status === 402) throw new Error("Crédits IA insuffisants");
    throw new Error("Erreur du service IA");
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "{}";

  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { raw, parse_error: true };
  }
}
