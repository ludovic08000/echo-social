import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Rate limiting per user
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
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

    const text = `
📊 Vue d'ensemble marché :
  • ${allProducts.length} produits actifs | ${uniqueSellers} vendeurs actifs

💰 PRIX PAR CATÉGORIE :
${catSummary}`;

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

    // ─── Auth check (CRITICAL FIX) ───
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rate limit
    if (!checkRateLimit(user.id)) {
      return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez dans un moment" }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

      const sb = createClient(supabaseUrl, supabaseKey);
      const { text: marketData } = await fetchMarketData(sb);

      // Verify the seller profile belongs to the authenticated user
      const { data: sellerProfile } = await sb
        .from("seller_profiles")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!sellerProfile) {
        return new Response(JSON.stringify({ error: "Profil vendeur introuvable" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const productsDetailed = (context?.products || [])
        .map((p: any, i: number) => `  ${i + 1}. "${p.title}" - ${p.price}€ | ${p.category}`)
        .join("\n");

      systemPrompt = `Tu es un coach IA expert marketplace pour le vendeur "${context?.sellerName || "Vendeur"}".
Données vendeur : ${context?.totalSales || 0} ventes, ${context?.productCount || 0} produits.
Catalogue : ${productsDetailed || "(vide)"}
${marketData}
Donne des conseils concrets en français.`;

      userMessages = (messages || []).map((m: any) => ({
        role: m.role,
        content: m.content,
      }));
    } else {
      return new Response(JSON.stringify({ error: "Action invalide" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        messages: [{ role: "system", content: systemPrompt }, ...userMessages],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) return new Response(JSON.stringify({ error: "Trop de requêtes" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (response.status === 402) return new Response(JSON.stringify({ error: "Crédits IA épuisés" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "Erreur IA" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("seller-ai-coach error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
