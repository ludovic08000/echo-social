import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function generateAdImage(apiKey: string, adTitle: string, adBody: string): Promise<string | null> {
  try {
    const prompt = `Create a professional, eye-catching social media advertisement image for: "${adTitle}". The ad is about: "${adBody}". Make it vibrant, modern, clean, with bold visuals. No text in the image, just a compelling visual. High quality, professional photography or illustration style.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: prompt }],
        modalities: ["image", "text"],
      }),
    });

    if (!response.ok) {
      console.error("Image gen error:", response.status);
      return null;
    }

    const data = await response.json();
    const imageUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    return imageUrl || null;
  } catch (e) {
    console.error("Image generation failed:", e);
    return null;
  }
}

async function uploadBase64ToStorage(base64Url: string): Promise<string | null> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Extract base64 data
    const matches = base64Url.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!matches) return null;

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const base64Data = matches[2];
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    const fileName = `ad-${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from('post-images')
      .upload(fileName, bytes, { contentType: `image/${matches[1]}`, upsert: true });

    if (error) {
      console.error("Upload error:", error);
      return null;
    }

    const { data: urlData } = supabase.storage.from('post-images').getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch (e) {
    console.error("Upload failed:", e);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { action } = body;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Conversational chat mode
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
                description: "Génère une campagne publicitaire complète. Appelle quand tu as assez d'infos.",
                parameters: {
                  type: "object",
                  properties: {
                    title: { type: "string", description: "Titre accrocheur (max 60 chars)" },
                    body: { type: "string", description: "Texte publicitaire (max 200 chars)" },
                    cta_text: { type: "string", description: "Texte du bouton d'action" },
                    target_age_min: { type: "number" },
                    target_age_max: { type: "number" },
                    target_gender: { type: "string", enum: ["all", "male", "female"] },
                    target_interests: { type: "array", items: { type: "string" } },
                    recommended_duration: { type: "string", enum: ["1_day", "3_days", "1_week", "2_weeks", "1_month", "3_months"] },
                    image_prompt: { type: "string", description: "Description détaillée de l'image à générer pour la pub" },
                    summary: { type: "string", description: "Résumé et conseils" },
                  },
                  required: ["title", "body", "cta_text", "target_age_min", "target_age_max", "target_gender", "recommended_duration", "image_prompt", "summary"],
                  additionalProperties: false,
                },
              },
            },
          ],
        }),
      });

      if (!response.ok) {
        if (response.status === 429) return new Response(JSON.stringify({ error: "Trop de requêtes." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        if (response.status === 402) return new Response(JSON.stringify({ error: "Crédits insuffisants." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        throw new Error("AI gateway error");
      }

      const data = await response.json();
      const choice = data.choices?.[0];

      if (choice?.message?.tool_calls?.length > 0) {
        const toolCall = choice.message.tool_calls[0];
        if (toolCall.function.name === "generate_ad_campaign") {
          const adData = JSON.parse(toolCall.function.arguments);

          // Generate the ad image
          let generatedImageUrl: string | null = null;
          if (adData.image_prompt) {
            const base64Image = await generateAdImage(LOVABLE_API_KEY, adData.title, adData.image_prompt);
            if (base64Image) {
              generatedImageUrl = await uploadBase64ToStorage(base64Image);
            }
          }

          return new Response(JSON.stringify({
            type: "ad_generated",
            message: adData.summary || "Voici votre publicité générée !",
            ad: { ...adData, generated_image_url: generatedImageUrl },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({
        type: "message",
        message: choice?.message?.content || "Je n'ai pas compris, pouvez-vous reformuler ?",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Generate image only action
    if (action === "generate_image") {
      const { title, description } = body;
      const base64Image = await generateAdImage(LOVABLE_API_KEY, title, description);
      if (base64Image) {
        const publicUrl = await uploadBase64ToStorage(base64Image);
        return new Response(JSON.stringify({ image_url: publicUrl }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Image generation failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Legacy actions
    const { product_name, product_description, target_audience, duration, budget, ad_title, ad_body } = body;
    let systemPrompt = "";
    let userPrompt = "";

    if (action === "generate_ad") {
      systemPrompt = `Tu es un expert marketing. Réponds en JSON: title, body, cta_text, targeting_tips (array), estimated_reach (string).`;
      userPrompt = `Pub pour: ${product_name}. Desc: ${product_description || "?"}. Audience: ${target_audience || "Large"}. Durée: ${duration || "1 semaine"}. Budget: ${budget || "?"}€.`;
    } else if (action === "moderate_ad") {
      systemPrompt = `Modérateur pub. Vérifie: pas de haine, fausses promesses, contenu explicite, produits illégaux, spam. JSON: approved (bool), score (1-10), reasons (array), suggestions (array).`;
      userPrompt = `Modère: Titre: ${ad_title || product_name}. Texte: ${ad_body || product_description}. Audience: ${target_audience || "?"}.`;
    } else {
      systemPrompt = `Assistant marketing. JSON: recommended_duration, recommended_budget, reasoning, audience_segments (array).`;
      userPrompt = `Stratégie: ${product_name}. Desc: ${product_description}. Budget: ${budget}€.`;
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
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
    } catch { parsed = { raw: content }; }

    return new Response(JSON.stringify(parsed), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("ad-assistant error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
