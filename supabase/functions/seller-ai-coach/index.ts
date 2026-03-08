import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function fetchMarketData(sb: any) {
  try {
    const { data: allProducts } = await sb
      .from("products")
      .select("category, price, title, seller_id, stock_quantity, images, description, thumbnail_url, product_type")
      .eq("is_active", true);

    if (!allProducts || allProducts.length === 0) return { text: "", products: [] };

    const catStats: Record<string, { prices: number[]; count: number; titles: string[]; descriptions: number }> = {};
    for (const p of allProducts) {
      const cat = p.category || "general";
      if (!catStats[cat]) catStats[cat] = { prices: [], count: 0, titles: [], descriptions: 0 };
      catStats[cat].prices.push(Number(p.price));
      catStats[cat].count++;
      if (catStats[cat].titles.length < 8) catStats[cat].titles.push(p.title);
      if (p.description && p.description.length > 20) catStats[cat].descriptions++;
    }

    const catSummary = Object.entries(catStats)
      .map(([cat, s]) => {
        const sorted = [...s.prices].sort((a, b) => a - b);
        const avg = (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2);
        const min = sorted[0].toFixed(2);
        const max = sorted[sorted.length - 1].toFixed(2);
        const median = sorted[Math.floor(sorted.length / 2)].toFixed(2);
        const descRate = Math.round((s.descriptions / s.count) * 100);
        return `  • ${cat}: ${s.count} produits | Min: ${min}€ | Médiane: ${median}€ | Moy: ${avg}€ | Max: ${max}€ | ${descRate}% avec description`;
      })
      .join("\n");

    const uniqueSellers = new Set(allProducts.map((p: any) => p.seller_id)).size;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: marketOrderCount30 } = await sb
      .from("orders")
      .select("id", { count: "exact", head: true })
      .gte("created_at", thirtyDaysAgo)
      .in("status", ["paid", "shipped", "delivered"]);

    const { count: marketOrderCount7 } = await sb
      .from("orders")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sevenDaysAgo)
      .in("status", ["paid", "shipped", "delivered"]);

    const { data: recentItems } = await sb
      .from("order_items")
      .select("product_id, quantity, subtotal, price, products(category, title, price)")
      .gte("created_at", thirtyDaysAgo);

    const catSales: Record<string, { qty: number; rev: number; soldPrices: number[]; productsSold: Set<string> }> = {};
    for (const oi of recentItems || []) {
      const cat = (oi as any).products?.category || "general";
      if (!catSales[cat]) catSales[cat] = { qty: 0, rev: 0, soldPrices: [], productsSold: new Set() };
      catSales[cat].qty += oi.quantity;
      catSales[cat].rev += Number(oi.subtotal);
      catSales[cat].soldPrices.push(Number(oi.price));
      catSales[cat].productsSold.add(oi.product_id);
    }

    const topCats = Object.entries(catSales)
      .sort((a, b) => b[1].rev - a[1].rev)
      .slice(0, 8)
      .map(([cat, s]) => {
        const avgSold = s.soldPrices.length > 0
          ? (s.soldPrices.reduce((a, b) => a + b, 0) / s.soldPrices.length).toFixed(2) : "N/A";
        const catTotal = catStats[cat]?.count || 1;
        const convRate = Math.round((s.productsSold.size / catTotal) * 100);
        return `  • ${cat}: ${s.qty} vendus | CA: ${s.rev.toFixed(0)}€ | Prix moyen vendu: ${avgSold}€ | Taux conversion: ~${convRate}%`;
      })
      .join("\n");

    // Detect underpriced products across marketplace
    const underpriced: string[] = [];
    for (const p of allProducts) {
      const cat = p.category || "general";
      const cs = catStats[cat];
      if (!cs || cs.prices.length < 3) continue;
      const sorted = [...cs.prices].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const ecart = ((Number(p.price) - median) / median) * 100;
      if (ecart < -25 && Number(p.price) > 1) {
        underpriced.push(`  ⚠️ "${p.title}" à ${p.price}€ (médiane catégorie: ${median.toFixed(0)}€, écart: ${ecart.toFixed(0)}%)`);
      }
    }

    const { data: allSellers } = await sb
      .from("seller_profiles")
      .select("rating_average, rating_count, total_sales, store_name")
      .gt("total_sales", 0)
      .order("total_sales", { ascending: false })
      .limit(10);

    let sellersInfo = "";
    if (allSellers && allSellers.length > 0) {
      const avgRating = allSellers
        .filter((s: any) => s.rating_count > 0)
        .reduce((sum: number, s: any) => sum + Number(s.rating_average || 0), 0) /
        Math.max(1, allSellers.filter((s: any) => s.rating_count > 0).length);
      sellersInfo = `
  • Note moyenne marketplace : ${avgRating.toFixed(1)}/5
  • Top vendeurs : ${allSellers.slice(0, 5).map((s: any) => `${s.store_name} (${s.total_sales} ventes, ${s.rating_average?.toFixed(1) || '?'}/5)`).join(" | ")}`;
    }

    const weeklyTrend = marketOrderCount7 && marketOrderCount30
      ? `${marketOrderCount7} commandes/7j vs ${Math.round((marketOrderCount30 || 0) / 4.3)}/semaine en moyenne`
      : "données insuffisantes";

    const text = `
🔍 INTELLIGENCE MARCHÉ (données temps réel de la marketplace ForSure) :
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Vue d'ensemble :
  • ${allProducts.length} produits actifs | ${uniqueSellers} vendeurs actifs
  • Commandes 30j : ${marketOrderCount30 || 0} | Tendance hebdo : ${weeklyTrend}
${sellersInfo}

💰 PRIX PAR CATÉGORIE (benchmark concurrentiel) :
${catSummary}

🔥 CATÉGORIES LES PLUS VENDUES (30j) — avec taux de conversion :
${topCats || "  (pas assez de données)"}

💎 ANNONCES POTENTIELLEMENT SOUS-ÉVALUÉES sur la marketplace :
${underpriced.length > 0 ? underpriced.slice(0, 10).join("\n") : "  Aucune annonce significativement sous-évaluée détectée."}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    return { text, products: allProducts };
  } catch (err) {
    console.error("Market data error:", err);
    return { text: "\n⚠️ Données marché temporairement indisponibles.", products: [] };
  }
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
    let model = "google/gemini-2.5-flash";

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

      userMessages = [{
        role: "user",
        content: `Génère une description optimisée pour ce produit :
Produit : ${productInfo}
${category ? `Catégorie : ${category}` : ""}
${price ? `Prix : ${price}€` : ""}`,
      }];
    } else if (action === "coach_chat") {
      const { messages, context } = body;

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, supabaseKey);

      const { text: marketData } = await fetchMarketData(sb);

      const avgOrder = context?.averageOrderValue || 0;

      // Build detailed product analysis data
      const productsDetailed = (context?.products || [])
        .map((p: any, i: number) => {
          const photoCount = p.photoCount || 0;
          const descQuality = p.descriptionQuality || "absente";
          return `  ${i + 1}. "${p.title}"
     Prix: ${p.price}€ | Catégorie: ${p.category} | Stock: ${p.stock ?? '∞'} | Type: ${p.productType || 'physical'}
     Photos: ${photoCount} | Description: ${descQuality} (${p.descriptionLength || 0} car.) | Créé: ${p.created?.slice(0, 10) || '?'}
     ${p.imageUrls?.length > 0 ? `Images: ${p.imageUrls.join(', ')}` : 'Aucune image'}`;
        })
        .join("\n");

      const ordersInfo = (context?.recentOrders || [])
        .map((o: any) => `  • ${o.date?.slice(0, 10)} — ${o.total}€ (${o.status}, ${o.items} articles)`)
        .join("\n");

      // Check if any product has images for vision analysis
      const hasImages = (context?.products || []).some((p: any) => p.imageUrls?.length > 0);
      if (hasImages) {
        model = "google/gemini-2.5-flash"; // Vision-capable model
      }

      systemPrompt = `RÔLE
Tu es une IA experte de niveau professionnel en marketplace, pricing dynamique, analyse visuelle et optimisation d'annonces sur ForSure Marketplace.

CAPACITÉS AVANCÉES :
1. 🔎 DÉTECTION AUTOMATIQUE : À partir du titre, tu identifies automatiquement le type de produit, la marque probable, le modèle, l'état estimé et la catégorie optimale.
2. 📸 ANALYSE DES PHOTOS : Tu évalues le nombre de photos, leur qualité estimée (luminosité, cadrage, fond), et donnes des conseils précis.
3. 💎 DÉTECTION SOUS-ÉVALUATION : Tu repères les annonces vendues bien en-dessous du marché (opportunités d'arbitrage).
4. 📊 ESTIMATION DEMANDE : Tu estimes la demande réelle en croisant volume de ventes de la catégorie, nombre de concurrents et tendances.
5. ✍️ RÉÉCRITURE AUTOMATIQUE : Tu proposes des titres et descriptions optimisés SEO pour chaque produit.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DONNÉES RÉELLES DU VENDEUR :
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 KPIs :
  • Boutique : ${context?.sellerName || "Vendeur"}
  • Ventes totales : ${context?.totalSales || 0}
  • CA total : ${context?.totalRevenue || 0}€
  • Panier moyen : ${avgOrder}€
  • Produits : ${context?.productCount || 0}
  • Commandes récentes : ${context?.orderCount || 0}
  • Note : ${context?.rating ? context.rating + "/5" : "Non notée"} (${context?.ratingCount || 0} avis)

📦 CATALOGUE DÉTAILLÉ DU VENDEUR :
${productsDetailed || "  (aucun produit)"}

🛒 COMMANDES RÉCENTES :
${ordersInfo || "  (aucune commande)"}
${marketData}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MÉTHODOLOGIE D'ANALYSE OBLIGATOIRE :

▶ ÉTAPE 1 — DÉTECTION PRODUIT
Pour chaque produit du vendeur, à partir du titre :
- Identifier : type exact, marque probable, modèle, état estimé
- Vérifier si la catégorie est optimale (recommander un changement si besoin)
- Identifier les mots-clés manquants dans le titre

▶ ÉTAPE 2 — ANALYSE DU MARCHÉ
Pour chaque produit :
- prix_minimum, prix_maximum, prix_moyen, prix_médian de la catégorie
- ecart = ((prix_vendeur - prix_médian) / prix_médian) × 100
- Interprétation :
  • < -15% → 🟢 Extrêmement compétitif (sous-évalué ?)
  • -15% à -5% → 🟢 Très bon prix
  • -5% à +5% → 🟡 Prix marché
  • +5% à +15% → 🟠 Légèrement cher
  • > +15% → 🔴 Trop cher

▶ ÉTAPE 3 — ANALYSE PHOTOS
Pour chaque produit :
- Nombre de photos (0-2: ❌ | 3-4: ⚠️ | 5-7: ✅ | 8+: 🌟)
- Si des URLs d'images sont disponibles, commenter la qualité
- Conseils spécifiques : angle, luminosité, fond, mise en scène

▶ ÉTAPE 4 — SCORE D'ANNONCE (/100)
Base = 100. Ajuster :
  • Prix : retirer |écart| × 2 points
  • Photos : 0-2 → -15 | 3-4 → -5 | 5-7 → +5 | 8+ → +10
  • Description : absente → -20 | faible → -10 | correcte → 0 | détaillée → +10
  • Livraison : physique sans frais → +5
  • Note vendeur bonne → +5 | mauvaise → -10
Limiter entre 0 et 100.

▶ ÉTAPE 5 — PROBABILITÉ DE VENTE & DEMANDE
  • Score 80-100 → 🟢 Élevée (vente < 3 jours)
  • Score 60-79 → 🟡 Moyenne (vente 3-10 jours)
  • Score 40-59 → 🟠 Faible (vente 10-30 jours)
  • Score < 40 → 🔴 Très faible (> 30 jours)
Estimer la demande en croisant : volume ventes catégorie (30j), nombre produits concurrents, tendance (hausse/baisse).

▶ ÉTAPE 6 — STRATÉGIE DE PRIX
  • prix_vente_rapide = prix_médian × 0.92
  • prix_optimal = prix_médian × 1.00
  • prix_maximum = prix_médian × 1.08

▶ ÉTAPE 7 — RÉÉCRITURE D'ANNONCE
Pour chaque produit sous-performant :
- 📝 Nouveau titre optimisé (avec mots-clés SEO)
- 📄 Nouvelle description complète (150-200 mots, emojis, bullet points, appel à l'action)
- #️⃣ Hashtags suggérés

▶ ÉTAPE 8 — DÉTECTION ARBITRAGE
Scanner le marché pour des produits vendus > 25% sous la médiane.
Signaler les opportunités d'achat-revente.

▶ ÉTAPE 9 — PLAN D'ACTION CHIFFRÉ
5 actions concrètes classées par IMPACT sur le CA :
Chaque action avec estimation d'impact (ex: "→ +15% conversions estimé")

FORMAT :
Tableaux markdown, emojis, sections claires. VRAIS chiffres uniquement.
Français, ton expert mais motivant.
Terminer par un RÉSUMÉ STRATÉGIQUE en 3 lignes.`;

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
        model,
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
