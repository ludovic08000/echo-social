import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sanitizeForAI } from "../_shared/ai-privacy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Pattern-based moderation features
const TOXIC_PATTERNS = [
  { pattern: /\b(kill|murder|die|death threat)\b/gi, weight: 30, category: "violence" },
  { pattern: /\b(fuck|shit|ass|bitch|connard|pute|merde|enculé)\b/gi, weight: 15, category: "profanity" },
  { pattern: /\b(n[i1]gg|f[a4]g|retard)\b/gi, weight: 40, category: "hate_speech" },
  { pattern: /\b(buy now|click here|free money|earn \$|congratulations you won)\b/gi, weight: 25, category: "spam" },
  { pattern: /(https?:\/\/\S+){3,}/gi, weight: 20, category: "link_spam" },
  { pattern: /(.)\1{5,}/g, weight: 10, category: "spam" },
  { pattern: /\b(suicide|self.harm|cut myself)\b/gi, weight: 35, category: "self_harm" },
  { pattern: /\b(nude|naked|porn|xxx|onlyfans)\b/gi, weight: 25, category: "nsfw" },
];

interface ModerationFeatures {
  toxicity_score: number;
  spam_score: number;
  nsfw_score: number;
  categories: string[];
  text_length: number;
  caps_ratio: number;
  emoji_ratio: number;
  url_count: number;
  repeated_chars_ratio: number;
}

function extractFeatures(text: string): ModerationFeatures {
  const categories = new Set<string>();
  let toxicity = 0;
  let spam = 0;
  let nsfw = 0;

  for (const rule of TOXIC_PATTERNS) {
    const matches = text.match(rule.pattern);
    if (matches) {
      const matchWeight = rule.weight * Math.min(matches.length, 3);
      categories.add(rule.category);
      if (["violence", "hate_speech", "self_harm", "profanity"].includes(rule.category)) {
        toxicity += matchWeight;
      } else if (["spam", "link_spam"].includes(rule.category)) {
        spam += matchWeight;
      } else if (rule.category === "nsfw") {
        nsfw += matchWeight;
      }
    }
  }

  const caps = text.replace(/[^A-Z]/g, "").length;
  const capsRatio = text.length > 0 ? caps / text.length : 0;
  if (capsRatio > 0.6 && text.length > 20) spam += 15;

  const urls = text.match(/https?:\/\/\S+/g) || [];
  if (urls.length > 2) spam += 10 * urls.length;

  const emojis = text.match(/[\u{1F600}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || [];
  const emojiRatio = text.length > 0 ? emojis.length / text.length : 0;

  const repeatedChars = text.match(/(.)\1{3,}/g) || [];
  const repeatedRatio = text.length > 0 ? repeatedChars.join("").length / text.length : 0;

  return {
    toxicity_score: Math.min(100, toxicity),
    spam_score: Math.min(100, spam),
    nsfw_score: Math.min(100, nsfw),
    categories: [...categories],
    text_length: text.length,
    caps_ratio: capsRatio,
    emoji_ratio: emojiRatio,
    url_count: urls.length,
    repeated_chars_ratio: repeatedRatio,
  };
}

function determineAction(features: ModerationFeatures, learnedRules: any[]): {
  action: "allow" | "flag_review" | "shadow_ban" | "remove";
  reason: string;
  confidence: number;
} {
  const maxScore = Math.max(features.toxicity_score, features.spam_score, features.nsfw_score);

  // Apply learned rules first
  for (const rule of learnedRules) {
    if (rule.pattern) {
      try {
        const regex = new RegExp(rule.pattern, "gi");
        if (regex.test("")) continue; // skip empty patterns
      } catch { continue; }
    }
  }

  if (maxScore >= 60) {
    return {
      action: "remove",
      reason: `Score élevé: toxicité=${features.toxicity_score}, spam=${features.spam_score}, nsfw=${features.nsfw_score}`,
      confidence: Math.min(0.95, 0.6 + maxScore / 200),
    };
  }
  if (maxScore >= 35) {
    return {
      action: "flag_review",
      reason: `Score moyen: catégories=${features.categories.join(", ")}`,
      confidence: Math.min(0.85, 0.5 + maxScore / 200),
    };
  }
  if (maxScore >= 20) {
    return {
      action: "flag_review",
      reason: "Contenu potentiellement problématique",
      confidence: 0.5,
    };
  }

  return { action: "allow", reason: "Contenu sûr", confidence: 0.85 };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { requireAuthenticated, requireAdmin } = await import("../_shared/auth-guard.ts");
    const authed = await requireAuthenticated(req, corsHeaders);
    if (!("userId" in authed)) return authed.response;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { action, text, post_id, feedback } = await req.json();

    // metrics action leaks model accuracy/confidence — admin only.
    if (action === "metrics") {
      const adminGuard = await requireAdmin(req, corsHeaders);
      if (!("userId" in adminGuard)) return adminGuard.response;
    }

    if (action === "moderate" && text) {
      const start = performance.now();

      // Load learned rules
      const { data: learnedRules } = await supabase
        .from("ai_learned_rules")
        .select("rule, pattern")
        .order("created_at", { ascending: false })
        .limit(50);

      const features = extractFeatures(text);
      const decision = determineAction(features, learnedRules || []);

      // For borderline cases, use AI for enhanced analysis
      let aiEnhanced = false;
      if (decision.action === "flag_review" && decision.confidence < 0.7) {
        try {
          const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
          if (LOVABLE_API_KEY) {
            const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash-lite",
                messages: [
                  { role: "system", content: "Tu es un modérateur de contenu. Analyse ce texte et réponds UNIQUEMENT par un JSON: {\"safe\": true/false, \"category\": \"string\", \"severity\": 0-10, \"reason\": \"string\"}" },
                  { role: "user", content: sanitizeForAI(text, 500) },
                ],
              }),
            });

            if (aiRes.ok) {
              const aiData = await aiRes.json();
              const content = aiData.choices?.[0]?.message?.content;
              if (content) {
                try {
                  const parsed = JSON.parse(content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
                  if (parsed.severity >= 7) {
                    decision.action = "remove";
                    decision.confidence = 0.9;
                  } else if (parsed.severity >= 4) {
                    decision.action = "flag_review";
                    decision.confidence = 0.75;
                  } else if (parsed.safe) {
                    decision.action = "allow";
                    decision.confidence = 0.8;
                  }
                  aiEnhanced = true;
                } catch {}
              }
            }
          }
        } catch (e) {
          console.warn("AI moderation fallback:", e);
        }
      }

      const latency = Math.round(performance.now() - start);

      // Log prediction
      let userId: string | null = null;
      if (authHeader) {
        const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: { user } } = await authClient.auth.getUser();
        userId = user?.id || null;
      }

      if (userId) {
        await supabase.from("ml_predictions").insert({
          domain: "moderation",
          user_id: userId,
          target_id: post_id || null,
          target_type: post_id ? "post" : "text",
          prediction: { ...decision, features, ai_enhanced: aiEnhanced },
          confidence: decision.confidence,
          latency_ms: latency,
        });
      }

      return new Response(JSON.stringify({
        safe: decision.action === "allow",
        action: decision.action,
        reason: decision.reason,
        confidence: decision.confidence,
        features,
        ai_enhanced: aiEnhanced,
        latency_ms: latency,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "feedback" && feedback) {
      // Training feedback loop
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Auth requise" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await authClient.auth.getUser();
      if (!user) {
        return new Response(JSON.stringify({ error: "Non authentifié" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase.from("ml_training_feedback").insert({
        prediction_id: feedback.prediction_id || null,
        domain: "moderation",
        original_label: feedback.original_label,
        corrected_label: feedback.corrected_label,
        feedback_source: "human",
        reviewer_id: user.id,
        reason: feedback.reason,
      });

      // Update prediction correctness
      if (feedback.prediction_id) {
        const isCorrect = feedback.original_label === feedback.corrected_label;
        await supabase.from("ml_predictions").update({ is_correct: isCorrect }).eq("id", feedback.prediction_id);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "metrics") {
      // Model performance metrics
      const { data: predictions } = await supabase
        .from("ml_predictions")
        .select("is_correct, confidence, latency_ms")
        .eq("domain", "moderation")
        .not("is_correct", "is", null)
        .order("created_at", { ascending: false })
        .limit(1000);

      const total = predictions?.length || 0;
      const correct = predictions?.filter((p: any) => p.is_correct).length || 0;
      const avgLatency = total > 0
        ? Math.round(predictions!.reduce((s: number, p: any) => s + (p.latency_ms || 0), 0) / total)
        : 0;
      const avgConfidence = total > 0
        ? Number((predictions!.reduce((s: number, p: any) => s + (p.confidence || 0), 0) / total).toFixed(4))
        : 0;

      return new Response(JSON.stringify({
        total_predictions: total,
        accuracy: total > 0 ? Number((correct / total).toFixed(4)) : 0,
        avg_latency_ms: avgLatency,
        avg_confidence: avgConfidence,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Action inconnue" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("ML Moderation error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erreur interne" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
