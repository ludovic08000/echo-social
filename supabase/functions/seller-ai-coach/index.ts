import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

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
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const body = await req.json();
    const { action } = body;

    let systemPrompt = "";
    let userMessages: any[] = [];

    if (action === "generate_description") {
      const { productInfo, category, price } = body;
      systemPrompt = `Tu es un expert en e-commerce et copywriting français. 
Génère une description de produit optimisée pour la vente en ligne.

Règles :
- Écris en français, ton professionnel mais accessible
- Structure avec des emojis, des bullet points
- Mets en avant les avantages et la valeur
- Inclus un appel à l'action
- Optimise pour le SEO (mots-clés naturels)
- Maximum 200 mots
- Ajoute des suggestions de hashtags à la fin`;

      userMessages = [
        {
          role: "user",
          content: `Génère une description optimisée pour ce produit :
Produit : ${productInfo}
${category ? `Catégorie : ${category}` : ''}
${price ? `Prix : ${price}€` : ''}`,
        },
      ];
    } else if (action === "coach_chat") {
      const { messages, context } = body;
      systemPrompt = `Tu es un coach de vente expert en e-commerce sur ForSure Marketplace, une marketplace française.

Données du vendeur :
- Boutique : ${context?.sellerName || 'Vendeur'}
- Ventes totales : ${context?.totalSales || 0}
- Revenus totaux : ${context?.totalRevenue || 0}€
- Nombre de produits : ${context?.productCount || 0}
- Commandes récentes : ${context?.orderCount || 0}

Tu dois :
- Donner des conseils personnalisés basés sur les données du vendeur
- Proposer des stratégies concrètes et actionnables
- Analyser les tendances et suggérer des améliorations
- Répondre en français, de manière concise et pratique
- Utiliser des bullet points et des emojis pour la lisibilité
- Si le vendeur a peu de ventes, encourager et donner des conseils pour démarrer
- Suggérer des optimisations de prix, photos, descriptions, marketing`;

      userMessages = (messages || []).map((m: any) => ({
        role: m.role,
        content: m.content,
      }));
    } else {
      return new Response(JSON.stringify({ error: "Action invalide" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
          ...userMessages,
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez plus tard" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Crédits IA épuisés" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "Erreur IA" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("seller-ai-coach error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
