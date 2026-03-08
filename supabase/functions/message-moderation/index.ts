import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const userClient = createClient(
      supabaseUrl,
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
    const { action } = body;

    // ── MODERATE MESSAGE ──
    if (action === "moderate_message") {
      const { messageBody, messageId } = body;

      if (!messageBody || typeof messageBody !== "string") {
        return new Response(JSON.stringify({ error: "messageBody required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Skip moderation for system/special messages
      if (messageBody.startsWith("📞 CALL:") || messageBody.startsWith("🎙️ voice:") || messageBody === "📷 Photo") {
        return new Response(JSON.stringify({ safe: true, reason: null }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Skip AI for very short messages (< 15 chars) — too short to be harmful, use basic check
      if (messageBody.length < 15) {
        const result = basicModeration(messageBody);
        if (!result.safe && messageId) {
          await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
        }
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check cache first
      const contentHash = await hashContent(messageBody);
      const { data: cached } = await supabase
        .from("ai_moderation_cache")
        .select("result")
        .eq("content_hash", contentHash)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (cached) {
        const result = cached.result as { safe: boolean; reason: string | null; category: string | null };
        if (!result.safe && messageId) {
          await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
        }
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // AI moderation via Lovable AI
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) {
        // Fallback: basic keyword-based moderation
        const result = basicModeration(messageBody);
        if (!result.safe && messageId) {
          await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
        }
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
              content: `Tu es un modérateur de contenu pour une messagerie de réseau social français.
Analyse le message et détermine s'il est sûr ou dangereux.
Catégories dangereuses : spam, harcèlement, arnaque/phishing, contenu sexuel explicite, menaces, discours haineux, publicité non sollicitée.
Réponds UNIQUEMENT avec la fonction tool_call fournie.`,
            },
            {
              role: "user",
              content: `Analyse ce message : "${messageBody.slice(0, 500)}"`,
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "moderation_result",
                description: "Return the moderation result for the message",
                parameters: {
                  type: "object",
                  properties: {
                    safe: { type: "boolean", description: "true if the message is safe, false if dangerous" },
                    reason: { type: "string", description: "Brief explanation in French if unsafe, null if safe" },
                    category: {
                      type: "string",
                      enum: ["spam", "harassment", "scam", "explicit", "threats", "hate_speech", "unsolicited_ads", "safe"],
                      description: "Category of the content",
                    },
                    confidence: { type: "number", description: "Confidence score 0-100" },
                  },
                  required: ["safe", "category", "confidence"],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "moderation_result" } },
        }),
      });

      if (!aiResponse.ok) {
        // Fallback to basic moderation on AI failure
        const result = basicModeration(messageBody);
        if (!result.safe && messageId) {
          await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
        }
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const aiData = await aiResponse.json();
      let moderationResult = { safe: true, reason: null as string | null, category: "safe", confidence: 50 };

      try {
        const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
        if (toolCall?.function?.arguments) {
          moderationResult = JSON.parse(toolCall.function.arguments);
        }
      } catch {
        // If parsing fails, default to safe
      }

      // Cache the result (1 hour)
      await supabase.from("ai_moderation_cache").insert({
        content_hash: contentHash,
        result: moderationResult,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      // If unsafe and high confidence, block the message
      if (!moderationResult.safe && moderationResult.confidence >= 70 && messageId) {
        await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);

        // Flag user trust score
        await supabase
          .from("trust_scores")
          .update({
            is_flagged: true,
            flag_reason: `Message blocked: ${moderationResult.category} - ${moderationResult.reason}`,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id);
      }

      return new Response(JSON.stringify({
        safe: moderationResult.safe,
        reason: moderationResult.reason,
        category: moderationResult.category,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ACCEPT MESSAGE REQUEST ──
    if (action === "accept_request") {
      const { conversationId } = body;
      if (!conversationId) {
        return new Response(JSON.stringify({ error: "conversationId required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Update all pending messages in this conversation to delivered
      const { error } = await supabase
        .from("messages")
        .update({ status: "delivered" })
        .eq("conversation_id", conversationId)
        .eq("status", "pending");

      if (error) throw error;

      return new Response(JSON.stringify({ accepted: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── REJECT MESSAGE REQUEST ──
    if (action === "reject_request") {
      const { conversationId } = body;
      if (!conversationId) {
        return new Response(JSON.stringify({ error: "conversationId required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Block all pending messages
      const { error } = await supabase
        .from("messages")
        .update({ status: "blocked" })
        .eq("conversation_id", conversationId)
        .eq("status", "pending");

      if (error) throw error;

      return new Response(JSON.stringify({ rejected: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use: moderate_message, accept_request, reject_request" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Simple hash for cache keys
async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fallback basic moderation (no AI needed)
function basicModeration(text: string): { safe: boolean; reason: string | null; category: string } {
  const lower = text.toLowerCase();

  // Scam/phishing patterns
  const scamPatterns = [
    /gagn(ez|er)\s+\d+\s*€/i,
    /cliquez?\s+ici\s+pour\s+gagner/i,
    /offre\s+exclusive\s+limit/i,
    /envoyez?\s+(moi\s+)?(votre|ton)\s+(numéro|carte|code|mot\s+de\s+passe)/i,
    /bitcoin|crypto\s+gratuit/i,
    /compte\s+bancaire|iban|rib/i,
    /bit\.ly|tinyurl|t\.co/i,
  ];

  for (const pattern of scamPatterns) {
    if (pattern.test(lower)) {
      return { safe: false, reason: "Message suspect : possibilité d'arnaque détectée", category: "scam" };
    }
  }

  // Spam patterns
  const spamPatterns = [
    /(.)\1{10,}/,  // 10+ repeated chars
    /(https?:\/\/[^\s]+\s*){4,}/i,  // 4+ URLs
  ];

  for (const pattern of spamPatterns) {
    if (pattern.test(text)) {
      return { safe: false, reason: "Message identifié comme spam", category: "spam" };
    }
  }

  return { safe: true, reason: null, category: "safe" };
}
