import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

      // ━━━ MARKET INTELLIGENCE: Query real DB data ━━━
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, supabaseKey);

      let marketData = "";
      try {
        // 1) Average prices per category across all sellers
        const { data: allProducts } = await sb
          .from("products")
          .select("category, price, title, seller_id")
          .eq("is_active", true);

        if (allProducts && allProducts.length > 0) {
          // Group by category
          const catStats: Record<string, { prices: number[]; count: number; titles: string[] }> = {};
          for (const p of allProducts) {
            const cat = p.category || "general";
            if (!catStats[cat]) catStats[cat] = { prices: [], count: 0, titles: [] };
            catStats[cat].prices.push(Number(p.price));
            catStats[cat].count++;
            if (catStats[cat].titles.length < 5) catStats[cat].titles.push(p.title);
          }

          const catSummary = Object.entries(catStats)
            .map(([cat, s]) => {
              const avg = (s.prices.reduce((a, b) => a + b, 0) / s.prices.length).toFixed(2);
              const min = Math.min(...s.prices).toFixed(2);
              const max = Math.max(...s.prices).toFixed(2);
              const median = s.prices.sort((a, b) => a - b)[Math.floor(s.prices.length / 2)].toFixed(2);
              return `  • ${cat}: ${s.count} produits | Moy: ${avg}€ | Médiane: ${median}€ | Min: ${min}€ | Max: ${max}€`;
            })
            .join("\n");

          // 2) Compare seller's products vs market
          const sellerProducts = context?.products || [];
          let priceComparison = "";
          if (sellerProducts.length > 0) {
            priceComparison = sellerProducts
              .map((sp: any) => {
                const cat = sp.category || "general";
                const cs = catStats[cat];
                if (!cs) return `  • ${sp.title} (${sp.price}€) — Pas assez de données marché`;
                const avg = cs.prices.reduce((a: number, b: number) => a + b, 0) / cs.prices.length;
                const diff = ((sp.price - avg) / avg * 100).toFixed(1);
                const position = Number(diff) > 10 ? "⬆️ AU-DESSUS du marché" :
                  Number(diff) < -10 ? "⬇️ EN-DESSOUS du marché" : "✅ DANS la moyenne";
                return `  • ${sp.title}: ${sp.price}€ vs moyenne ${avg.toFixed(2)}€ (${diff > "0" ? "+" : ""}${diff}%) → ${position}`;
              })
              .join("\n");
          }

          // 3) Count unique sellers
          const uniqueSellers = new Set(allProducts.map(p => p.seller_id)).size;

          // 4) Recent orders trends (last 30 days for whole marketplace)
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          const { data: recentMarketOrders, count: marketOrderCount } = await sb
            .from("orders")
            .select("total, created_at", { count: "exact" })
            .gte("created_at", thirtyDaysAgo)
            .in("status", ["paid", "shipped", "delivered"]);

          const marketRevenue30d = recentMarketOrders?.reduce((s, o) => s + Number(o.total), 0) || 0;

          // 5) Top categories by order volume
          const { data: recentOrderItems } = await sb
            .from("order_items")
            .select("product_id, quantity, subtotal, products(category)")
            .gte("created_at", thirtyDaysAgo);

          const catSales: Record<string, { qty: number; rev: number }> = {};
          for (const oi of recentOrderItems || []) {
            const cat = (oi as any).products?.category || "general";
            if (!catSales[cat]) catSales[cat] = { qty: 0, rev: 0 };
            catSales[cat].qty += oi.quantity;
            catSales[cat].rev += Number(oi.subtotal);
          }
          const topCats = Object.entries(catSales)
            .sort((a, b) => b[1].rev - a[1].rev)
            .slice(0, 5)
            .map(([cat, s]) => `  • ${cat}: ${s.qty} vendus, ${s.rev.toFixed(0)}€ CA`)
            .join("\n");

          // 6) Product reviews stats for seller
          let reviewInsight = "";
          if (context?.rating) {
            // Get marketplace avg rating
            const { data: allSellers } = await sb
              .from("seller_profiles")
              .select("rating_average, rating_count")
              .gt("rating_count", 0);
            if (allSellers && allSellers.length > 0) {
              const avgRating = allSellers.reduce((s, x) => s + Number(x.rating_average || 0), 0) / allSellers.length;
              reviewInsight = `\n📝 Avis :
  • Ta note : ${context.rating}/5 (${context.ratingCount} avis) vs moyenne marketplace : ${avgRating.toFixed(1)}/5`;
            }
          }

          marketData = `

🔍 INTELLIGENCE MARCHÉ (données temps réel de la marketplace) :
━━━━━━━━━━━━━━━━━━━━━━━
📊 Vue d'ensemble marché :
  • ${allProducts.length} produits actifs sur la marketplace
  • ${uniqueSellers} vendeurs actifs
  • ${marketOrderCount || 0} commandes (30 derniers jours)
  • CA marketplace 30j : ${marketRevenue30d.toFixed(0)}€

💰 Prix moyens par catégorie (CONCURRENCE) :
${catSummary}

🏷️ POSITIONNEMENT PRIX du vendeur vs marché :
${priceComparison || "  (aucun produit à comparer)"}

🔥 Catégories les plus vendues (30j) :
${topCats || "  (pas assez de données)"}
${reviewInsight}
━━━━━━━━━━━━━━━━━━━━━━━`;
        }
      } catch (dbErr) {
        console.error("Market data fetch error:", dbErr);
        marketData = "\n⚠️ Données marché temporairement indisponibles.";
      }

      const avgOrder = context?.averageOrderValue || 0;
      const productsInfo = (context?.products || [])
        .map((p: any) => `• ${p.title} — ${p.price}€ (${p.category}, stock: ${p.stock ?? '∞'})`)
        .join('\n');
      const ordersInfo = (context?.recentOrders || [])
        .map((o: any) => `• ${o.date?.slice(0, 10)} — ${o.total}€ (${o.status}, ${o.items} articles)`)
        .join('\n');

      systemPrompt = `Tu es un coach de vente IA EXPERT de niveau professionnel sur ForSure Marketplace, une marketplace française.
Tu as accès aux DONNÉES RÉELLES du vendeur ET aux données du marché pour faire une analyse concurrentielle complète.

DONNÉES RÉELLES DU VENDEUR :
━━━━━━━━━━━━━━━━━━━━━━━
📊 KPIs :
- Boutique : ${context?.sellerName || 'Vendeur'}
- Ventes totales : ${context?.totalSales || 0}
- Chiffre d'affaires total : ${context?.totalRevenue || 0}€
- Panier moyen : ${avgOrder}€
- Nombre de produits : ${context?.productCount || 0}
- Commandes récentes : ${context?.orderCount || 0}
- Note moyenne : ${context?.rating ? context.rating + '/5' : 'Pas encore notée'} (${context?.ratingCount || 0} avis)

📦 Catalogue produits du vendeur :
${productsInfo || '(aucun produit)'}

🛒 Commandes récentes du vendeur :
${ordersInfo || '(aucune commande)'}
${marketData}

INSTRUCTIONS D'ANALYSE IA AVANCÉE :
Tu dois agir comme un vrai consultant e-commerce professionnel :

1. 🎯 ANALYSE CONCURRENTIELLE : Compare CHAQUE produit du vendeur aux prix moyens du marché. Indique clairement si le prix est trop haut, trop bas ou bien positionné. Calcule l'écart en % et en €.

2. 💡 RECOMMANDATIONS DE PRIX : Pour chaque produit mal positionné, propose un prix optimal avec justification (ex: "Baisse ton X de 15€ à 12€ (-20%) pour s'aligner sur la médiane du marché").

3. 📈 ANALYSE DES TENDANCES : Identifie les catégories qui se vendent le mieux. Si le vendeur n'est pas dans ces catégories, suggère d'y entrer.

4. 🏆 SCORE DE PERFORMANCE : Donne une note /100 au vendeur en prenant en compte : diversité catalogue, positionnement prix, volume de ventes, satisfaction client.

5. 🚀 PLAN D'ACTION : 5 actions concrètes classées par impact potentiel sur le CA, avec estimation chiffrée de l'impact (ex: "Action 1: Baisser le prix du produit X → impact estimé +15% de conversions").

6. ⚠️ ALERTES : Signale les produits en rupture de stock, les prix aberrants, les catégories saturées.

7. 📊 MÉTRIQUES CALCULÉES :
   - Part de marché estimée du vendeur (CA vendeur / CA marketplace)
   - Taux de conversion estimé
   - Position prix par rapport aux concurrents (percentile)

RÈGLES :
- Utilise LES VRAIS CHIFFRES, ne les invente JAMAIS
- Sois direct et pragmatique, pas de blabla
- Chaque recommandation doit être chiffrée
- Utilise des emojis, bullet points, tableaux markdown
- Réponds en français
- Si tu manques de données, dis-le clairement et donne des conseils génériques en attendant`;

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
