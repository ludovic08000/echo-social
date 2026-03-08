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

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    const { order_id, video_url } = await req.json();
    if (!order_id || !video_url) {
      throw new Error("order_id et video_url requis");
    }

    // Verify order exists and total > 100€
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, total, packing_video_status")
      .eq("id", order_id)
      .single();

    if (orderErr || !order) throw new Error("Commande introuvable");
    if (order.total < 100) throw new Error("Vidéo non requise pour cette commande");

    // Update status to analyzing
    await supabase
      .from("orders")
      .update({ packing_video_url: video_url, packing_video_status: "analyzing" })
      .eq("id", order_id);

    // Ask AI to analyze the video for signs of manipulation
    const systemPrompt = `Tu es un expert en analyse vidéo anti-fraude pour une marketplace.
Tu dois analyser une vidéo d'emballage de colis et déterminer si elle est authentique ou manipulée.

Critères d'authenticité :
- La vidéo montre un emballage continu sans coupures suspectes
- Le produit est visible avant d'être mis dans le colis
- Pas de signes de montage (sauts d'image, changements brusques de luminosité, incohérences temporelles)
- L'arrière-plan reste cohérent tout au long de la vidéo
- Les mains/mouvements sont naturels et continus

Critères de suspicion :
- Coupures visibles dans la vidéo
- Changements brusques de cadrage ou d'éclairage
- Compression excessive suggérant une re-encodage
- Incohérences visuelles entre les segments
- Vidéo trop courte (moins de 10 secondes)

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
              {
                type: "text",
                text: `Analyse cette vidéo d'emballage de colis pour détecter d'éventuels montages ou manipulations. URL de la vidéo : ${video_url}`,
              },
              {
                type: "image_url",
                image_url: { url: video_url },
              },
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
                  is_authentic: {
                    type: "boolean",
                    description: "true si la vidéo semble authentique, false si elle semble manipulée",
                  },
                  confidence: {
                    type: "number",
                    description: "Score de confiance entre 0 et 100",
                  },
                  issues: {
                    type: "array",
                    items: { type: "string" },
                    description: "Liste des problèmes détectés (vide si authentique)",
                  },
                  summary: {
                    type: "string",
                    description: "Résumé court de l'analyse en français",
                  },
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
      const status = response.status;
      if (status === 429) {
        await supabase
          .from("orders")
          .update({ packing_video_status: "error" })
          .eq("id", order_id);
        return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez dans quelques minutes" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (status === 402) {
        await supabase
          .from("orders")
          .update({ packing_video_status: "error" })
          .eq("id", order_id);
        return new Response(JSON.stringify({ error: "Crédits IA insuffisants" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await response.text();
      console.error("AI gateway error:", status, errText);
      await supabase
        .from("orders")
        .update({ packing_video_status: "error" })
        .eq("id", order_id);
      throw new Error("Erreur lors de l'analyse IA");
    }

    const aiData = await response.json();
    console.log("AI response:", JSON.stringify(aiData));

    let analysis = {
      is_authentic: true,
      confidence: 50,
      issues: [] as string[],
      summary: "Analyse non disponible",
    };

    // Parse tool call response
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      try {
        analysis = JSON.parse(toolCall.function.arguments);
      } catch {
        console.error("Failed to parse AI tool response");
      }
    }

    // Determine final status
    const finalStatus = analysis.is_authentic && analysis.confidence >= 60
      ? "verified"
      : "rejected";

    await supabase
      .from("orders")
      .update({ packing_video_status: finalStatus })
      .eq("id", order_id);

    return new Response(
      JSON.stringify({
        status: finalStatus,
        analysis,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("verify-packing-video error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erreur interne" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
