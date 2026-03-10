import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.2";
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

async function generateAdImage(apiKey: string, adTitle: string, adBody: string): Promise<string | null> {
  try {
    const prompt = `Create a professional, eye-catching social media advertisement image for: "${adTitle}". The ad is about: "${adBody}". Make it vibrant, modern, clean, with bold visuals. No text in the image, just a compelling visual.`;

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
    return data.choices?.[0]?.message?.images?.[0]?.image_url?.url || null;
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

    const matches = base64Url.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!matches) return null;

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const base64Data = matches[2];
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    const fileName = `ad-${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from('post-images')
      .upload(fileName, bytes, { contentType: `image/${matches[1]}`, upsert: true });

    if (error) { console.error("Upload error:", error); return null; }

    const { data: urlData } = supabase.storage.from('post-images').getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch (e) {
    console.error("Upload failed:", e);
    return null;
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // ─── Auth check (CRITICAL FIX) ───
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
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
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Conversational chat mode
    if (action === "chat") {
      const { messages } = body;

      const systemPrompt = `Tu es l'assistant publicitaire IA de ForSure Ads. Tu aides les utilisateurs à créer des publicités performantes.
Ton rôle : poser des questions, proposer des idées créatives, conseiller sur le ciblage et le budget.
Sois concis, enthousiaste et professionnel. Réponds en français.`;

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
            ...messages,
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "generate_ad_campaign",
                description: "Génère une campagne publicitaire complète.",
                parameters: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" },
                    cta_text: { type: "string" },
                    target_age_min: { type: "number" },
                    target_age_max: { type: "number" },
                    target_gender: { type: "string", enum: ["all", "male", "female"] },
                    target_interests: { type: "array", items: { type: "string" } },
                    recommended_duration: { type: "string", enum: ["1_day", "3_days", "1_week", "2_weeks", "1_month", "3_months"] },
                    image_prompt: { type: "string" },
                    summary: { type: "string" },
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
          let generatedImageUrl: string | null = null;
          if (adData.image_prompt) {
            const base64Image = await generateAdImage(LOVABLE_API_KEY, adData.title, adData.image_prompt);
            if (base64Image) generatedImageUrl = await uploadBase64ToStorage(base64Image);
          }
          return new Response(JSON.stringify({
            type: "ad_generated",
            message: adData.summary || "Voici votre publicité générée !",
            ad: { ...adData, generated_image_url: generatedImageUrl },
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      return new Response(JSON.stringify({
        type: "message",
        message: choice?.message?.content || "Je n'ai pas compris, pouvez-vous reformuler ?",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Generate image only
    if (action === "generate_image") {
      const { title, description } = body;
      const base64Image = await generateAdImage(LOVABLE_API_KEY, title, description);
      if (base64Image) {
        const publicUrl = await uploadBase64ToStorage(base64Image);
        return new Response(JSON.stringify({ image_url: publicUrl }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "Image generation failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Legacy actions
    const { product_name, product_description, target_audience, duration, budget, ad_title, ad_body } = body;
    let systemPrompt = "";
    let userPrompt = "";

    if (action === "generate_ad") {
      systemPrompt = `Tu es un expert marketing. Réponds en JSON: title, body, cta_text, targeting_tips (array), estimated_reach (string).`;
      userPrompt = `Pub pour: ${product_name}. Desc: ${product_description || "?"}. Audience: ${target_audience || "Large"}. Durée: ${duration || "1 semaine"}. Budget: ${budget || "?"}€.`;
    } else if (action === "moderate_ad") {
      systemPrompt = `Modérateur pub. JSON: approved (bool), score (1-10), reasons (array), suggestions (array).`;
      userPrompt = `Modère: Titre: ${ad_title || product_name}. Texte: ${ad_body || product_description}.`;
    } else {
      systemPrompt = `Assistant marketing. JSON: recommended_duration, recommended_budget, reasoning, audience_segments (array).`;
      userPrompt = `Stratégie: ${product_name}. Desc: ${product_description}. Budget: ${budget}€.`;
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
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
