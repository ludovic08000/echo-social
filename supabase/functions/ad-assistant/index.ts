import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { action } = body;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Conversational chat mode for ad creation assistant
    if (action === "chat") {
      const { messages } = body;

      const systemPrompt = `Tu es l'assistant publicitaire IA de ForSure Ads. Tu aides les utilisateurs à créer des publicités performantes.

Ton rôle :
1. Poser des questions pour comprendre le produit/service, l'audience cible, le budget
2. Proposer des idées créatives de titres et textes publicitaires
3. Conseiller sur le ciblage (âge, genre, intérêts)
4. Recommander la durée et le budget optimal

Quand tu as assez d'informations pour générer la pub, utilise l'outil generate_ad_campaign.

Sois concis, enthousiaste et professionnel. Utilise des emojis avec parcimonie. Réponds en français.`;

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
            ...messages,
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "generate_ad_campaign",
                description: "Génère une campagne publicitaire complète à partir des informations collectées. Appelle cette fonction quand tu as assez d'informations.",
                parameters: {
                  type: "object",
                  properties: {
                    title: { type: "string", description: "Titre accrocheur de la pub (max 60 caractères)" },
                    body: { type: "string", description: "Texte publicitaire engageant (max 200 caractères)" },
                    cta_text: { type: "string", description: "Texte du bouton d'action (ex: En savoir plus, Acheter maintenant)" },
                    target_age_min: { type: "number", description: "Âge minimum de l'audience cible" },
                    target_age_max: { type: "number", description: "Âge maximum de l'audience cible" },
                    target_gender: { type: "string", enum: ["all", "male", "female"], description: "Genre cible" },
                    target_interests: { type: "array", items: { type: "string" }, description: "Centres d'intérêt de l'audience" },
                    recommended_duration: { type: "string", enum: ["1_day", "3_days", "1_week", "2_weeks", "1_month", "3_months"], description: "Durée recommandée" },
                    summary: { type: "string", description: "Résumé et conseils pour l'utilisateur" },
                  },
                  required: ["title", "body", "cta_text", "target_age_min", "target_age_max", "target_gender", "recommended_duration", "summary"],
                  additionalProperties: false,
                },
              },
            },
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
      const choice = data.choices?.[0];
      
      // Check if the AI called the tool
      if (choice?.message?.tool_calls?.length > 0) {
        const toolCall = choice.message.tool_calls[0];
        if (toolCall.function.name === "generate_ad_campaign") {
          const adData = JSON.parse(toolCall.function.arguments);
          return new Response(JSON.stringify({
            type: "ad_generated",
            message: adData.summary || "Voici votre publicité générée !",
            ad: adData,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Regular text response
      return new Response(JSON.stringify({
        type: "message",
        message: choice?.message?.content || "Je n'ai pas compris, pouvez-vous reformuler ?",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Legacy actions (moderate_ad, generate_ad, etc.)
    const { product_name, product_description, target_audience, duration, budget, ad_title, ad_body } = body;

    let systemPrompt = "";
    let userPrompt = "";

    if (action === "generate_ad") {
      systemPrompt = `Tu es un expert en marketing digital. Réponds TOUJOURS en JSON valide avec: title, body, cta_text, targeting_tips (array), estimated_reach (string).`;
      userPrompt = `Crée une publicité pour: ${product_name}. Description: ${product_description || "Non spécifié"}. Audience: ${target_audience || "Large"}. Durée: ${duration || "1 semaine"}. Budget: ${budget || "?"}€.`;
    } else if (action === "moderate_ad") {
      systemPrompt = `Tu es un modérateur de contenu publicitaire. Vérifie: pas de haine, fausses promesses, contenu explicite, produits illégaux, spam, ciblage discriminatoire. Réponds en JSON: approved (boolean), score (1-10), reasons (array), suggestions (array).`;
      userPrompt = `Modère: Titre: ${ad_title || product_name}. Texte: ${ad_body || product_description}. Audience: ${target_audience || "Non spécifié"}.`;
    } else {
      systemPrompt = `Tu es un assistant marketing. Réponds en JSON avec: recommended_duration, recommended_budget, reasoning, audience_segments (array).`;
      userPrompt = `Stratégie pour: ${product_name}. Description: ${product_description}. Budget: ${budget}€.`;
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
      if (response.status === 429) return new Response(JSON.stringify({ error: "Trop de requêtes." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (response.status === 402) return new Response(JSON.stringify({ error: "Crédits insuffisants." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      throw new Error("AI gateway error");
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    
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
