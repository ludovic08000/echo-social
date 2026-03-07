import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    const { roomName, isHost } = await req.json();

    if (!roomName) {
      return new Response(
        JSON.stringify({ error: "roomName is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("name, avatar_url")
      .eq("user_id", userId)
      .single();

    const identity = userId;
    const name = profile?.name || "Utilisateur";

    const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY")!;
    const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET")!;

    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity,
      name,
      metadata: JSON.stringify({ avatar_url: profile?.avatar_url }),
    });

    // For private calls (room starts with "call-"), both parties can publish
    const isPrivateCall = roomName.startsWith("call-");

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: isPrivateCall ? true : !!isHost,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await at.toJwt();
    const livekitUrl = Deno.env.get("LIVEKIT_URL")!;

    return new Response(
      JSON.stringify({ token: jwt, url: livekitUrl }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("LiveKit token error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
