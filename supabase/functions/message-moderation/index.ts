import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { sanitizeForAI } from "../_shared/ai-privacy.ts";

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

      // ── Check if the recipient is a minor ──
      let recipientIsMinor = false;
      if (messageId) {
        const { data: msg } = await supabase
          .from("messages")
          .select("conversation_id")
          .eq("id", messageId)
          .maybeSingle();

        if (msg) {
          const { data: otherParticipant } = await supabase
            .from("conversation_participants")
            .select("user_id")
            .eq("conversation_id", msg.conversation_id)
            .neq("user_id", user.id)
            .maybeSingle();

          if (otherParticipant) {
            const { data: minorCheck } = await supabase
              .from("parental_controls")
              .select("is_active")
              .eq("user_id", otherParticipant.user_id)
              .eq("is_active", true)
              .maybeSingle();

            recipientIsMinor = !!minorCheck;

            // Log adult-minor contact for detection
            if (recipientIsMinor) {
              await supabase.from("minor_contact_logs").insert({
                adult_user_id: user.id,
                minor_user_id: otherParticipant.user_id,
                contact_type: "message",
              });
            }
          }
        }
      }

      // Skip AI for very short messages (< 15 chars) — unless recipient is minor
      if (messageBody.length < 15 && !recipientIsMinor) {
        const result = basicModeration(messageBody);
        if (!result.safe && messageId) {
          await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
        }
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check cache first
      const cacheKey = recipientIsMinor ? `minor:${messageBody}` : messageBody;
      const contentHash = await hashContent(cacheKey);
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
        const result = recipientIsMinor
          ? basicMinorModeration(messageBody)
          : basicModeration(messageBody);
        if (!result.safe && messageId) {
          await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
        }
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ── Build the AI prompt based on context ──
      const systemPrompt = recipientIsMinor
        ? `Tu es un système de protection des mineurs pour un réseau social français.
Tu analyses les messages envoyés par des adultes à des mineurs de moins de 16 ans.
Tu dois détecter les comportements de grooming et les tentatives de manipulation :

CATÉGORIES DANGEREUSES :
- grooming : flatterie excessive, compliments sur le physique, tentative de créer un lien spécial ("notre secret"), normalisation de sujets adultes
- isolation : tentative d'éloigner le mineur de ses parents/amis ("ne dis pas à tes parents", "on peut parler ailleurs ?")
- personal_info : demande d'informations personnelles (adresse, école, photos, numéro de téléphone, localisation)
- inappropriate : contenu sexuel, allusions sexuelles, langage inapproprié pour un mineur
- manipulation : chantage émotionnel, menaces voilées, culpabilisation
- scam : arnaque, phishing
- harassment : harcèlement, insultes
- safe : message normal et approprié

IMPORTANT : Sois très vigilant. En cas de doute, signale le message. La sécurité du mineur prime.
Réponds UNIQUEMENT avec la fonction tool_call fournie.`
        : `Tu es un modérateur de contenu pour une messagerie de réseau social français.
Analyse le message et détermine s'il est sûr ou dangereux.
Catégories dangereuses : spam, harcèlement, arnaque/phishing, contenu sexuel explicite, menaces, discours haineux, publicité non sollicitée.
Réponds UNIQUEMENT avec la fonction tool_call fournie.`;

      const categories = recipientIsMinor
        ? ["grooming", "isolation", "personal_info", "inappropriate", "manipulation", "scam", "harassment", "safe"]
        : ["spam", "harassment", "scam", "explicit", "threats", "hate_speech", "unsolicited_ads", "safe"];

      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Analyse ce message : "${sanitizeForAI(messageBody, 500)}"` },
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
                      enum: categories,
                      description: "Category of the content",
                    },
                    confidence: { type: "number", description: "Confidence score 0-100" },
                    severity: {
                      type: "string",
                      enum: ["low", "medium", "high", "critical"],
                      description: "Severity level of the detected issue",
                    },
                  },
                  required: ["safe", "category", "confidence", "severity"],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "moderation_result" } },
        }),
      });

      if (!aiResponse.ok) {
        const result = recipientIsMinor
          ? basicMinorModeration(messageBody)
          : basicModeration(messageBody);
        if (!result.safe && messageId) {
          await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
        }
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const aiData = await aiResponse.json();
      let moderationResult = { safe: true, reason: null as string | null, category: "safe", confidence: 50, severity: "low" as string };

      try {
        const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
        if (toolCall?.function?.arguments) {
          moderationResult = JSON.parse(toolCall.function.arguments);
        }
      } catch {
        // If parsing fails, default to safe
      }

      // Cache the result (6 hours, but only 1h for minor-related)
      const cacheDuration = recipientIsMinor ? 1 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
      await supabase.from("ai_moderation_cache").insert({
        content_hash: contentHash,
        result: moderationResult,
        expires_at: new Date(Date.now() + cacheDuration).toISOString(),
      });

      // ── Determine blocking threshold ──
      // For minors: lower threshold (50% confidence) and immediate action on critical
      const blockThreshold = recipientIsMinor ? 50 : 70;
      const shouldBlock = !moderationResult.safe && moderationResult.confidence >= blockThreshold;

      if (shouldBlock && messageId) {
        await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);

        // Flag user trust score
        const flagPrefix = recipientIsMinor ? "⚠️ MINOR PROTECTION" : "Message blocked";
        await supabase
          .from("trust_scores")
          .update({
            is_flagged: true,
            flag_reason: `${flagPrefix}: ${moderationResult.category} - ${moderationResult.reason}`,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id);

        // For critical severity towards minors, auto-create abuse report
        if (recipientIsMinor && (moderationResult.severity === "critical" || moderationResult.severity === "high")) {
          await supabase.from("abuse_reports").insert({
            reporter_id: user.id, // system-generated
            reported_user_id: user.id,
            report_type: `ai_minor_protection_${moderationResult.category}`,
            description: `[AUTO] IA a détecté un message dangereux envers un mineur. Catégorie: ${moderationResult.category}. Raison: ${moderationResult.reason}. Sévérité: ${moderationResult.severity}. Confiance: ${moderationResult.confidence}%`,
          });
        }
      }

      return new Response(JSON.stringify({
        safe: moderationResult.safe,
        reason: moderationResult.reason,
        category: moderationResult.category,
        minorProtection: recipientIsMinor,
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

      // SECURITY: Verify user is a participant of this conversation
      const { data: participant } = await supabase
        .from("conversation_participants")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (!participant) {
        return new Response(JSON.stringify({ error: "Vous ne faites pas partie de cette conversation" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
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

      // SECURITY: Verify user is a participant of this conversation
      const { data: participant } = await supabase
        .from("conversation_participants")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (!participant) {
        return new Response(JSON.stringify({ error: "Vous ne faites pas partie de cette conversation" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
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

// Fallback moderation for messages to minors (no AI)
function basicMinorModeration(text: string): { safe: boolean; reason: string | null; category: string } {
  const lower = text.toLowerCase();

  // First run basic moderation
  const basic = basicModeration(text);
  if (!basic.safe) return basic;

  // Grooming patterns
  const groomingPatterns = [
    /t'es\s+(trop\s+)?(belle|beau|mignon|mignonne|sexy|jolie|joli|canon)/i,
    /envoie\s+(moi\s+)?(une|ta|des)\s+(photo|image|selfie|vidéo)/i,
    /dis\s+(pas|rien)\s+(à|aux)\s+(tes\s+)?(parents|père|mère|mama|papa|famille)/i,
    /notre\s+secret/i,
    /on\s+peut\s+(se\s+)?(voir|rencontrer|retrouver)/i,
    /tu\s+habites?\s+(où|ou)/i,
    /quel(le)?\s+(âge|école|collège|lycée)/i,
    /(ton|ta)\s+(numéro|tel|téléphone|insta|snap|whatsapp|tiktok)/i,
    /je\s+suis\s+(ton|ta)\s+(ami|copain|copine|confident)/i,
    /t'inquiète\s+pas.*entre\s+nous/i,
    /personne\s+(ne\s+)?saura/i,
    /webcam|cam[éè]ra|facetime/i,
  ];

  for (const pattern of groomingPatterns) {
    if (pattern.test(lower)) {
      return { safe: false, reason: "Message suspect détecté envers un mineur", category: "grooming" };
    }
  }

  // Isolation patterns
  const isolationPatterns = [
    /ne\s+(dis|parle|raconte)\s+(rien|pas|jamais)\s+(à|aux)/i,
    /tes\s+parents\s+(ne\s+)?(compren|savent|doivent)/i,
    /viens\s+(sur|en)\s+(privé|dm|mp)/i,
    /on\s+(parle|discute)\s+(ailleurs|autre\s+part)/i,
  ];

  for (const pattern of isolationPatterns) {
    if (pattern.test(lower)) {
      return { safe: false, reason: "Tentative d'isolement détectée envers un mineur", category: "isolation" };
    }
  }

  return { safe: true, reason: null, category: "safe" };
}
