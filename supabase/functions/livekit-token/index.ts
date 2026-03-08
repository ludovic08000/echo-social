import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Rate limiting: max 10 token requests per minute per user
const rateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(userId, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

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
