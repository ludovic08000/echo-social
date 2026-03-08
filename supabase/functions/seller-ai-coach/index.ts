import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function fetchMarketData(sb: any, sellerCategories: string[]) {
  try {
    // 1) All active products
    const { data: allProducts } = await sb
      .from("products")
      .select("category, price, title, seller_id, stock_quantity, images, product_type")
      .eq("is_active", true);

    if (!allProducts || allProducts.length === 0) return null;

    // Category stats
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
        const sorted = [...s.prices].sort((a, b) => a - b);
        const avg = (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2);
        const min = sorted[0].toFixed(2);
        const max = sorted[sorted.length - 1].toFixed(2);
        const median = sorted[Math.floor(sorted.length / 2)].toFixed(2);
        return `  • ${cat}: ${s.count} produits | Min: ${min}€ | Médiane: ${median}€ | Moy: ${avg}€ | Max: ${max}€`;
      })
      .join("\n");

    const uniqueSellers = new Set(allProducts.map((p: any) => p.seller_id)).size;

    // 2) Recent orders (30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentOrders, count: marketOrderCount } = await sb
      .from("orders")
      .select("total, created_at", { count: "exact" })
      .gte("created_at", thirtyDaysAgo)
      .in("status", ["paid", "shipped", "delivered"]);

    const marketRevenue30d = recentOrders?.reduce((s: number, o: any) => s + Number(o.total), 0) || 0;

    // 3) Top categories by sales
    const { data: recentItems } = await sb
      .from("order_items")
      .select("product_id, quantity, subtotal, products(category, price)")
      .gte("created_at", thirtyDaysAgo);

    const catSales: Record<string, { qty: number; rev: number; avgPrice: number[]; count: number }> = {};
    for (const oi of recentItems || []) {
      const cat = (oi as any).products?.category || "general";
      if (!catSales[cat]) catSales[cat] = { qty: 0, rev: 0, avgPrice: [], count: 0 };
      catSales[cat].qty += oi.quantity;
      catSales[cat].rev += Number(oi.subtotal);
      catSales[cat].avgPrice.push(Number((oi as any).products?.price || 0));
      catSales[cat].count++;
    }

    const topCats = Object.entries(catSales)
      .sort((a, b) => b[1].rev - a[1].rev)
      .slice(0, 8)
      .map(([cat, s]) => {
        const avgSalePrice = s.avgPrice.length > 0
          ? (s.avgPrice.reduce((a, b) => a + b, 0) / s.avgPrice.length).toFixed(2)
          : "N/A";
        return `  • ${cat}: ${s.qty} vendus | CA: ${s.rev.toFixed(0)}€ | Prix moyen vendu: ${avgSalePrice}€`;
      })
      .join("\n");

    // 4) Avg ratings across marketplace
    const { data: allSellers } = await sb
      .from("seller_profiles")
      .select("rating_average, rating_count, total_sales, store_name")
      .gt("total_sales", 0);

    let topSellersInfo = "";
    if (allSellers && allSellers.length > 0) {
      const avgMarketRating = allSellers
        .filter((s: any) => s.rating_count > 0)
        .reduce((sum: number, s: any) => sum + Number(s.rating_average || 0), 0) /
        Math.max(1, allSellers.filter((s: any) => s.rating_count > 0).length);

      const totalMarketSales = allSellers.reduce((s: number, x: any) => s + (x.total_sales || 0), 0);

      topSellersInfo = `
  • Note moyenne marketplace : ${avgMarketRating.toFixed(1)}/5
  • Ventes totales marketplace : ${totalMarketSales}
  • Top vendeurs : ${allSellers.sort((a: any, b: any) => (b.total_sales || 0) - (a.total_sales || 0)).slice(0, 3).map((s: any) => `${s.store_name} (${s.total_sales} ventes)`).join(", ")}`;
    }

    // 5) Velocity: avg time from listing to first sale per category
    // (simplified: days since product creation vs order count)

    return `
🔍 INTELLIGENCE MARCHÉ (données temps réel) :
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Vue d'ensemble :
  • ${allProducts.length} produits actifs | ${uniqueSellers} vendeurs actifs
  • ${marketOrderCount || 0} commandes (30j) | CA 30j : ${marketRevenue30d.toFixed(0)}€
${topSellersInfo}

💰 PRIX PAR CATÉGORIE (pour comparaison concurrentielle) :
${catSummary}

🔥 CATÉGORIES LES PLUS VENDUES (30 derniers jours) :
${topCats || "  (pas assez de données de ventes)"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  } catch (err) {
    console.error("Market data error:", err);
    return "\n⚠️ Données marché temporairement indisponibles.";
  }
}

function buildSellerComparison(sellerProducts: any[], catStats: any) {
  if (!sellerProducts || sellerProducts.length === 0) return "";
  // This is handled in the prompt itself via the market data
  return "";
}

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
${category ? `Catégorie : ${category}` : ""}
${price ? `Prix : ${price}€` : ""}`,
        },
      ];
    } else if (action === "coach_chat") {
      const { messages, context } = body;

      // Fetch real market data from DB
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, supabaseKey);

      const sellerCategories = (context?.products || []).map((p: any) => p.category).filter(Boolean);
      const marketData = await fetchMarketData(sb, sellerCategories);

      const avgOrder = context?.averageOrderValue || 0;
      const productsInfo = (context?.products || [])
        .map((p: any, i: number) => `  ${i + 1}. ${p.title} — ${p.price}€ (catégorie: ${p.category}, stock: ${p.stock ?? "∞"}, créé: ${p.created?.slice(0, 10) || "?"})`)
        .join("\n");
      const ordersInfo = (context?.recentOrders || [])
        .map((o: any) => `  • ${o.date?.slice(0, 10)} — ${o.total}€ (${o.status}, ${o.items} articles)`)
        .join("\n");

      systemPrompt = `RÔLE
Tu es une IA experte en marketplace, pricing dynamique et optimisation d'annonces sur ForSure Marketplace (marketplace française).
Ta mission est d'agir comme un coach de vente professionnel qui analyse les produits d'un vendeur et l'aide à maximiser ses chances de vendre rapidement au meilleur prix.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DONNÉES RÉELLES DU VENDEUR :
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 KPIs :
  • Boutique : ${context?.sellerName || "Vendeur"}
  • Ventes totales : ${context?.totalSales || 0}
  • Chiffre d'affaires total : ${context?.totalRevenue || 0}€
  • Panier moyen : ${avgOrder}€
  • Nombre de produits : ${context?.productCount || 0}
  • Commandes récentes : ${context?.orderCount || 0}
  • Note moyenne : ${context?.rating ? context.rating + "/5" : "Pas encore notée"} (${context?.ratingCount || 0} avis)

📦 Catalogue produits du vendeur :
${productsInfo || "  (aucun produit)"}

🛒 Commandes récentes :
${ordersInfo || "  (aucune commande)"}
${marketData || ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MÉTHODOLOGIE D'ANALYSE OBLIGATOIRE :

ÉTAPE 1 — ANALYSE DU MARCHÉ
Pour CHAQUE produit du vendeur :
- Récupérer les prix des articles similaires (même catégorie) dans les données marché
- Calculer : prix_minimum, prix_maximum, prix_moyen, prix_médian
- Calculer l'écart : ecart = ((prix_vendeur - prix_médian) / prix_médian) × 100
- Interpréter :
  • écart < -15% → 🟢 prix extrêmement compétitif
  • -15% à -5% → 🟢 très bon prix
  • -5% à +5% → 🟡 prix marché
  • +5% à +15% → 🟠 légèrement trop cher
  • > +15% → 🔴 trop cher

ÉTAPE 2 — SCORE GLOBAL D'ANNONCE (/100)
Base = 100, puis ajuster :
  • Impact prix : retirer |écart| × 2 points
  • Photos : 0-2 → -10 | 3-4 → 0 | 5-7 → +5 | 8+ → +10
  • Description : faible → -10 | correcte → 0 | détaillée → +10
  • Livraison disponible : non → -10 | oui → +10
  • Note vendeur vs moyenne marché : bonus/malus proportionnel
  • Stock : en rupture → -15
Limiter entre 0 et 100.

ÉTAPE 3 — PROBABILITÉ DE VENTE
  • Score 80-100 → 🟢 Élevée
  • Score 60-79 → 🟡 Moyenne
  • Score 40-59 → 🟠 Faible
  • Score < 40 → 🔴 Très faible

ÉTAPE 4 — ESTIMATION TEMPS DE VENTE
  • Prix très compétitif → vente rapide (temps moyen × 0.5)
  • Prix marché → vente normale (temps moyen)
  • Prix trop élevé → vente lente (temps moyen × 2)

ÉTAPE 5 — STRATÉGIE DE PRIX (pour chaque produit)
  • prix_vente_rapide = prix_médian × 0.95
  • prix_optimal = prix_médian
  • prix_maximum = prix_médian × 1.08

ÉTAPE 6 — ANALYSE QUALITATIVE
  • Qualité des titres (longueur, mots-clés, SEO)
  • Diversité du catalogue
  • Cohérence de la gamme de prix
  • Position par rapport aux top vendeurs

ÉTAPE 7 — PLAN D'ACTION CONCRET
5 actions classées par impact potentiel sur le CA :
  • Chaque action avec estimation chiffrée d'impact
  • Ex: "Baisser le produit X de 25€ à 20€ → +30% de probabilité de vente"

FORMAT DE RÉPONSE OBLIGATOIRE :
Utiliser des tableaux markdown, emojis, sections claires.
Chaque analyse doit être chiffrée avec les VRAIS chiffres du marché.
Ne JAMAIS inventer de données — si pas assez de data, le dire clairement.
Répondre en français, ton professionnel mais motivant.
Terminer par un RÉSUMÉ STRATÉGIQUE en 3 lignes max.`;

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
