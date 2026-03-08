import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Rate limiting per user
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

const MAX_TEXT_LENGTH = 5000;
const ALLOWED_ACTIONS = ["improve", "formal", "casual", "shorter", "longer"];

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // ─── Auth check ───
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { text, action } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // ─── Input validation ───
    if (!text || typeof text !== "string" || !text.trim()) {
      return new Response(JSON.stringify({ error: "Texte requis" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return new Response(JSON.stringify({ error: `Texte trop long. Maximum: ${MAX_TEXT_LENGTH} caractères` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const safeAction = ALLOWED_ACTIONS.includes(action) ? action : "improve";

    const systemPrompt = `Tu es un assistant d'écriture pour un réseau social. Tu DOIS répondre en utilisant l'outil improve_text. Ne réponds JAMAIS en texte libre.

Ton rôle selon l'action demandée :

- "improve" : Corrige les fautes d'orthographe, améliore le style et la fluidité du texte tout en gardant le ton et l'intention de l'auteur. Garde la même langue que le texte original.
- "formal" : Rends le texte plus professionnel et formel.
- "casual" : Rends le texte plus décontracté et amical.
- "shorter" : Raccourcis le texte en gardant l'essentiel.
- "longer" : Développe le texte avec plus de détails.

Détecte automatiquement la langue du texte et indique-la dans le champ "detected_language".
Indique les corrections apportées dans "corrections" (liste courte).`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Action: ${safeAction}\n\nTexte:\n${text}` },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "improve_text",
              description: "Retourne le texte amélioré avec les métadonnées",
              parameters: {
                type: "object",
                properties: {
                  improved_text: { type: "string", description: "Le texte corrigé/amélioré" },
                  detected_language: { type: "string", description: "Langue détectée (fr, en, es, de, it, pt, etc.)" },
                  corrections: {
                    type: "array",
                    items: { type: "string" },
                    description: "Liste courte des corrections/améliorations apportées",
                  },
                  tone: { type: "string", description: "Ton détecté: casual, formal, neutral, enthusiastic" },
                },
                required: ["improved_text", "detected_language", "corrections", "tone"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "improve_text" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Crédits IA insuffisants." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error("AI gateway error");
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];

    if (toolCall?.function?.name === "improve_text") {
      const result = JSON.parse(toolCall.function.arguments);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      improved_text: text,
      detected_language: "unknown",
      corrections: [],
      tone: "neutral",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("post-assistant error:", e);
    return new Response(JSON.stringify({ error: "Erreur interne" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
