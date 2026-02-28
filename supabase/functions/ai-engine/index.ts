import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const { action, text, context, feedback } = await req.json();

    if (!action) {
      return new Response(
        JSON.stringify({ error: "Missing 'action' parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
Only output valid JSON, nothing else.`;
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
- "engagement_prediction": string ("high", "medium", "low") - predict if this will generate engagement
- "virality_score": number 0-100 - likelihood of going viral
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
- "fatigue_risk": string ("low", "medium", "high") - risk of content fatigue
- "personality_type": string (detected personality archetype)
Only output valid JSON.`;
        userPrompt = JSON.stringify(context || {});
        break;
      }

      case "learn_feedback": {
        systemPrompt = `You are a self-learning AI moderator. You received feedback on a previous moderation decision. Analyze the feedback and return JSON:
- "acknowledged": boolean
- "adjustment": string (what would you adjust in future similar cases)
- "new_rules": string[] (any new rules to derive from this feedback)
- "pattern": string (describe the pattern that should be learned)
Only output valid JSON.`;
        userPrompt = JSON.stringify(feedback || {});
        break;
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

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

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
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Trop de requêtes IA, réessayez dans un moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Crédits IA insuffisants." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      return new Response(
        JSON.stringify({ error: "Erreur du service IA" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "{}";

    // Parse JSON from response, handling markdown code blocks
    let result;
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      result = JSON.parse(cleaned);
    } catch {
      result = { raw, parse_error: true };
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
