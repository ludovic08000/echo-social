import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { action, product_name, product_description, target_audience, duration, budget } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    let systemPrompt = "";
    let userPrompt = "";

    if (action === "generate_ad") {
      systemPrompt = `Tu es un expert en marketing digital et publicité sur les réseaux sociaux. Tu crées des publicités percutantes, engageantes et optimisées pour la conversion. Réponds TOUJOURS en JSON valide avec les champs: title, body, cta_text, targeting_tips (array de strings), estimated_reach (string).`;
      userPrompt = `Crée une publicité pour:
- Produit/Service: ${product_name}
- Description: ${product_description || "Non spécifié"}
- Audience cible: ${target_audience || "Large"}
- Durée: ${duration || "1 semaine"}
- Budget: ${budget || "Non spécifié"}€

Génère un titre accrocheur (max 60 chars), un texte publicitaire engageant (max 200 chars), un CTA percutant, des conseils de ciblage, et une estimation de portée.`;
    } else if (action === "optimize_ad") {
      systemPrompt = `Tu es un expert en optimisation publicitaire. Analyse la publicité et donne des conseils d'amélioration. Réponds en JSON avec: score (1-10), improvements (array de strings), optimized_title, optimized_body.`;
      userPrompt = `Optimise cette publicité:
- Titre: ${product_name}
- Texte: ${product_description}
- Audience: ${target_audience || "Large"}`;
    } else {
      systemPrompt = `Tu es un assistant marketing. Aide à définir la meilleure stratégie publicitaire. Réponds en JSON avec: recommended_duration, recommended_budget, reasoning (string), audience_segments (array de strings).`;
      userPrompt = `Recommande une stratégie publicitaire pour: ${product_name}. Description: ${product_description}. Budget disponible: ${budget}€.`;
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
        return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez plus tard." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Crédits insuffisants." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI error:", response.status, t);
      throw new Error("AI gateway error");
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    
    // Try to extract JSON from the response
    let parsed;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: content };
    } catch {
      parsed = { raw: content };
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("ad-assistant error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
