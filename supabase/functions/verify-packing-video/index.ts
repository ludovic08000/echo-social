import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

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

    // ─── Auth check (CRITICAL FIX) ───
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { order_id, video_url } = await req.json();
    if (!order_id || !video_url) {
      throw new Error("order_id et video_url requis");
    }

    // Verify order exists, total > 100€, AND the user is the seller for this order
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, total, packing_video_status")
      .eq("id", order_id)
      .single();

    if (orderErr || !order) throw new Error("Commande introuvable");
    if (order.total < 100) throw new Error("Vidéo non requise pour cette commande");

    // Verify user is a seller on this order
    const { data: orderItems } = await supabase
      .from("order_items")
      .select("seller_id")
      .eq("order_id", order_id);

    const { data: sellerProfile } = await supabase
      .from("seller_profiles")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    const isSellerOnOrder = sellerProfile && orderItems?.some((i: any) => i.seller_id === sellerProfile.id);
    if (!isSellerOnOrder) {
      return new Response(JSON.stringify({ error: "Vous n'êtes pas le vendeur de cette commande" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase
      .from("orders")
      .update({ packing_video_url: video_url, packing_video_status: "analyzing" })
      .eq("id", order_id);

    const systemPrompt = `Tu es un expert en analyse vidéo anti-fraude pour une marketplace.
Tu dois analyser une vidéo d'emballage de colis et déterminer si elle est authentique ou manipulée.
Tu dois répondre UNIQUEMENT en utilisant le tool fourni.`;

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
          {
            role: "user",
            content: [
              { type: "text", text: `Analyse cette vidéo d'emballage de colis. URL : ${video_url}` },
              { type: "image_url", image_url: { url: video_url } },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "video_analysis_result",
              description: "Retourne le résultat de l'analyse vidéo",
              parameters: {
                type: "object",
                properties: {
                  is_authentic: { type: "boolean" },
                  confidence: { type: "number" },
                  issues: { type: "array", items: { type: "string" } },
                  summary: { type: "string" },
                },
                required: ["is_authentic", "confidence", "issues", "summary"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "video_analysis_result" } },
      }),
    });

    if (!response.ok) {
      await supabase.from("orders").update({ packing_video_status: "error" }).eq("id", order_id);
      if (response.status === 429) return new Response(JSON.stringify({ error: "Trop de requêtes" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (response.status === 402) return new Response(JSON.stringify({ error: "Crédits IA insuffisants" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      throw new Error("Erreur lors de l'analyse IA");
    }

    const aiData = await response.json();
    let analysis = { is_authentic: true, confidence: 50, issues: [] as string[], summary: "Analyse non disponible" };

    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      try { analysis = JSON.parse(toolCall.function.arguments); } catch {}
    }

    const finalStatus = analysis.is_authentic && analysis.confidence >= 60 ? "verified" : "rejected";
    await supabase.from("orders").update({ packing_video_status: finalStatus }).eq("id", order_id);

    return new Response(JSON.stringify({ status: finalStatus, analysis }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("verify-packing-video error:", e);
    const msg = e instanceof Error ? e.message : "Erreur interne";
    const isValidation = ["requis", "introuvable", "non requise", "Non authentifié", "vendeur"].some(s => msg.includes(s));
    return new Response(JSON.stringify({ error: msg }), {
      status: isValidation ? 400 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
