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
      const avgOrder = context?.averageOrderValue || 0;
      const productsInfo = (context?.products || [])
        .map((p: any) => `• ${p.title} — ${p.price}€ (${p.category}, stock: ${p.stock ?? '∞'})`)
        .join('\n');
      const ordersInfo = (context?.recentOrders || [])
        .map((o: any) => `• ${o.date?.slice(0, 10)} — ${o.total}€ (${o.status}, ${o.items} articles)`)
        .join('\n');

      systemPrompt = `Tu es un coach de vente expert en e-commerce sur ForSure Marketplace, une marketplace française.

DONNÉES RÉELLES DU VENDEUR — analyse ces chiffres en détail :
━━━━━━━━━━━━━━━━━━━━━━━
📊 KPIs :
- Boutique : ${context?.sellerName || 'Vendeur'}
- Ventes totales : ${context?.totalSales || 0}
- Chiffre d'affaires total : ${context?.totalRevenue || 0}€
- Panier moyen : ${avgOrder}€
- Nombre de produits : ${context?.productCount || 0}
- Commandes récentes : ${context?.orderCount || 0}
- Note moyenne : ${context?.rating ? context.rating + '/5' : 'Pas encore notée'} (${context?.ratingCount || 0} avis)

📦 Catalogue produits :
${productsInfo || '(aucun produit)'}

🛒 Commandes récentes :
${ordersInfo || '(aucune commande)'}
━━━━━━━━━━━━━━━━━━━━━━━

Tu dois :
- Faire une VRAIE analyse chiffrée basée sur les données ci-dessus
- Calculer des métriques : taux de conversion, panier moyen, produits les plus/moins vendus
- Identifier les points forts et les faiblesses concrètes
- Donner des recommandations ACTIONNABLES numérotées par priorité
- Proposer des objectifs chiffrés réalistes (ex: "+20% de CA en 30 jours")
- Si peu de données, expliquer les étapes pour démarrer
- Répondre en français, ton motivant mais professionnel
- Utiliser des emojis, bullet points, sections claires
- Chaque conseil doit être spécifique au vendeur, pas générique`;

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
