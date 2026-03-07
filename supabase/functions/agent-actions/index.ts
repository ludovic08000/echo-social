import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let userId: string | null = null;
    if (authHeader) {
      const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: { user } } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
      userId = user?.id || null;
    }
    if (!userId) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action } = await req.json();
    if (!action?.type) {
      return new Response(JSON.stringify({ error: "Action requise" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let result: any = {};

    // Generate image if needed
    let imageUrl: string | null = null;
    const imagePrompt = action.image_prompt || (action.type === "create_story" ? action.image_prompt : null) || (action.type === "generate_image" ? action.prompt : null);

    if (imagePrompt) {
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

      console.log("Generating image with prompt:", imagePrompt);

      const imgResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-image",
          messages: [{ role: "user", content: `Generate a high quality social media image: ${imagePrompt}` }],
          modalities: ["image", "text"],
        }),
      });

      if (imgResp.ok) {
        const imgData = await imgResp.json();
        const base64Url = imgData.choices?.[0]?.message?.images?.[0]?.image_url?.url;

        if (base64Url) {
          // Upload to storage
          const base64Data = base64Url.replace(/^data:image\/\w+;base64,/, "");
          const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
          const fileName = `${userId}/${Date.now()}.png`;
          const bucket = action.type === "create_story" ? "post-images" : "post-images";

          const { error: uploadErr } = await supabase.storage
            .from(bucket)
            .upload(fileName, binaryData, { contentType: "image/png", upsert: true });

          if (!uploadErr) {
            const { data: publicUrl } = supabase.storage.from(bucket).getPublicUrl(fileName);
            imageUrl = publicUrl.publicUrl;
          } else {
            console.error("Upload error:", uploadErr);
          }
        }
      } else {
        console.error("Image generation failed:", await imgResp.text());
      }
    }

    switch (action.type) {
      case "publish_post": {
        const { data, error } = await supabase
          .from("posts")
          .insert({
            user_id: userId,
            body: action.body || "",
            image_url: imageUrl,
          })
          .select("id")
          .single();

        if (error) throw error;
        result = { success: true, post_id: data.id, message: "Post publié avec succès ! 🎉", image_url: imageUrl };
        break;
      }

      case "schedule_post": {
        const publishAt = action.publish_at;
        if (!publishAt) throw new Error("Date de publication requise");

        const { data, error } = await supabase
          .from("posts")
          .insert({
            user_id: userId,
            body: action.body || "",
            image_url: imageUrl,
            publish_at: publishAt,
          })
          .select("id")
          .single();

        if (error) throw error;
        result = {
          success: true,
          post_id: data.id,
          message: `Post programmé pour le ${new Date(publishAt).toLocaleDateString("fr-FR", { dateStyle: "full" })} à ${new Date(publishAt).toLocaleTimeString("fr-FR", { timeStyle: "short" })} 📅`,
          image_url: imageUrl,
        };
        break;
      }

      case "create_story": {
        if (!imageUrl) throw new Error("Image requise pour créer une story");

        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        const { data, error } = await supabase
          .from("stories")
          .insert({
            user_id: userId,
            image_url: imageUrl,
            caption: action.caption || null,
            expires_at: expiresAt.toISOString(),
          })
          .select("id")
          .single();

        if (error) throw error;
        result = { success: true, story_id: data.id, message: "Story publiée ! Elle expirera dans 24h ✨", image_url: imageUrl };
        break;
      }

      case "generate_image": {
        if (!imageUrl) throw new Error("Échec de la génération d'image");
        result = { success: true, message: "Image générée avec succès ! 🎨", image_url: imageUrl };
        break;
      }

      default:
        throw new Error(`Action inconnue: ${action.type}`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("agent-actions error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
